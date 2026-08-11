// -----------------------------------------------------------------------------
// track.rs - ByteTrack-style identity for the person detector.
//
// The person detector re-runs from scratch on every sampled frame, so the box
// at index 0 this frame is not the human that was at index 0 last frame. The
// UI's person "lock" needs the same kind of durable key the ArUco path already
// gets for free from a marker id. This module supplies it.
//
// Ultralytics' `.track()` is a Python post-processing layer; the app runs
// `yolo26n.onnx` through `ort`, so association has to live here. The algorithm
// is ByteTrack: associate the confident detections first, then give every
// still-unmatched track a second chance against the *low*-scoring leftovers,
// which is what carries an id through a partial occlusion.
//
// Presentation only. Nothing here observes or commands the aircraft, and a
// predicted box is never handed back to the caller: `update` returns exactly
// the tracks that a real detection landed on this frame.
// -----------------------------------------------------------------------------

/// Birth threshold, and the score above which a detection is trusted enough to
/// drive the first association pass. This is the value the model-side filter
/// used to enforce on its own; the tracker owns it now.
pub const DEFAULT_HIGH_CONFIDENCE: f32 = 0.40;

/// Floor for the second association pass. A person who walks behind a chair
/// keeps producing a box, just a weak one - that is the box worth 0.10-0.40
/// that ByteTrack recovers. Below 0.10 the detector's output is noise and is
/// not allowed to influence any track.
pub const DEFAULT_LOW_CONFIDENCE: f32 = 0.10;

/// Overlap required to call a prediction and a detection the same person.
/// 0.30 is deliberately loose: person analysis runs at 10 Hz, so a walker
/// covers a real fraction of their own width between two frames even when the
/// constant-velocity estimate is right.
pub const DEFAULT_IOU_MATCH: f32 = 0.30;

/// Frames a track may go unmatched before it is destroyed. Person analysis is
/// capped at 10 Hz, so 15 frames is about 1.5 s of coasting - long enough to
/// cross behind a doorway, short enough that the id does not outlive the
/// operator's memory of what it was attached to.
pub const DEFAULT_MAX_MISSED: u32 = 15;

/// Weight of the newest centre delta in the velocity estimate. A full Kalman
/// filter is not justified here: at 10 Hz and at the object scale of a person
/// filling a good part of a 960x720 frame, the process noise dwarfs the
/// measurement noise, so a Kalman gain would sit pinned near 1 and the filter
/// would degenerate into exactly this exponential average - at the cost of a
/// 4x4 covariance update per track per frame.
const VELOCITY_SMOOTHING: f32 = 0.5;

/// One detector output for the current frame. `bbox` is `[x, y, width, height]`
/// in source-frame pixels: the same rectangle convention the person event puts
/// on the wire.
#[derive(Debug, Clone, Copy)]
pub struct Observation {
    pub bbox: [f32; 4],
    pub confidence: f32,
}

/// A detection that carries identity. `bbox` and `confidence` are always the
/// values *measured* this frame, never the tracker's prediction.
#[derive(Debug, Clone, Copy)]
pub struct Track {
    pub id: u32,
    pub bbox: [f32; 4],
    pub confidence: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct TrackerConfig {
    pub high_confidence: f32,
    pub low_confidence: f32,
    pub iou_match: f32,
    pub max_missed: u32,
}

impl Default for TrackerConfig {
    fn default() -> Self {
        Self {
            high_confidence: DEFAULT_HIGH_CONFIDENCE,
            low_confidence: DEFAULT_LOW_CONFIDENCE,
            iou_match: DEFAULT_IOU_MATCH,
            max_missed: DEFAULT_MAX_MISSED,
        }
    }
}

#[derive(Debug)]
struct LiveTrack {
    id: u32,
    /// Last measured rectangle, `[x, y, width, height]`.
    bbox: [f32; 4],
    /// Smoothed centre displacement per analysis frame.
    velocity: [f32; 2],
    confidence: f32,
    /// Consecutive frames since the last match. 0 means matched last frame.
    missed: u32,
}

impl LiveTrack {
    /// Where the track is expected to be now. Coasting is linear in the number
    /// of frames skipped, so a track that has been missing a while searches a
    /// correspondingly further-out neighbourhood. Size is not extrapolated:
    /// one centre delta says nothing reliable about scale change.
    fn predict(&self) -> [f32; 4] {
        let coast = (self.missed + 1) as f32;
        let (width, height) = (self.bbox[2], self.bbox[3]);
        [
            self.bbox[0] + self.velocity[0] * coast,
            self.bbox[1] + self.velocity[1] * coast,
            width,
            height,
        ]
    }

    fn observe(&mut self, observation: &Observation) {
        let previous_centre = centre(&self.bbox);
        let measured_centre = centre(&observation.bbox);
        // Divide by the frames actually skipped. Re-acquiring after a two
        // second occlusion is not evidence of a two second per frame velocity.
        let span = (self.missed + 1) as f32;
        let delta = [
            (measured_centre[0] - previous_centre[0]) / span,
            (measured_centre[1] - previous_centre[1]) / span,
        ];
        self.velocity[0] += VELOCITY_SMOOTHING * (delta[0] - self.velocity[0]);
        self.velocity[1] += VELOCITY_SMOOTHING * (delta[1] - self.velocity[1]);
        self.bbox = observation.bbox;
        self.confidence = observation.confidence;
        self.missed = 0;
    }
}

pub struct Tracker {
    config: TrackerConfig,
    tracks: Vec<LiveTrack>,
    next_id: u32,
    // Per-frame scratch, retained so a steady scene allocates nothing after
    // the first few frames. Every buffer is cleared at the top of `update`.
    predictions: Vec<[f32; 4]>,
    track_taken: Vec<bool>,
    detection_taken: Vec<bool>,
    detection_pool: Vec<usize>,
    pairs: Vec<(f32, usize, usize)>,
    matches: Vec<(usize, usize)>,
}

impl Tracker {
    pub fn new(config: TrackerConfig) -> Self {
        Self {
            config,
            tracks: Vec::new(),
            next_id: 0,
            predictions: Vec::new(),
            track_taken: Vec::new(),
            detection_taken: Vec::new(),
            detection_pool: Vec::new(),
            pairs: Vec::new(),
            matches: Vec::new(),
        }
    }

    /// Ends the current tracking session: every live track is destroyed. The
    /// id counter deliberately keeps running, so a lock the UI is still
    /// holding from the previous session can never be re-satisfied by a
    /// coincidentally equal id in the next one.
    pub fn reset(&mut self) {
        self.tracks.clear();
    }

    /// Advances every track by one frame and associates it with `detections`.
    ///
    /// Returns exactly the tracks a detection landed on this frame, ordered
    /// highest confidence first (ties broken by id) so the UI's default
    /// selection stays deterministic. A track that was only predicted is not
    /// returned: the caller's invariant is that every emitted box is a real
    /// measurement from the current frame. A newly born track is likewise
    /// withheld until a second detection confirms it, which is what upstream
    /// ByteTrack does with its `is_activated` flag and which costs one
    /// analysis frame - 100 ms here - in exchange for never surfacing a
    /// single-frame false positive as a selectable person.
    pub fn update(&mut self, detections: &[Observation]) -> Vec<Track> {
        let Self {
            config,
            tracks,
            next_id,
            predictions,
            track_taken,
            detection_taken,
            detection_pool,
            pairs,
            matches,
        } = self;

        // 1. Predict.
        predictions.clear();
        predictions.extend(tracks.iter().map(LiveTrack::predict));
        track_taken.clear();
        track_taken.resize(tracks.len(), false);
        detection_taken.clear();
        detection_taken.resize(detections.len(), false);
        matches.clear();

        // 2. First association: the confident detections against every live
        //    track, including ones currently coasting through a miss.
        detection_pool.clear();
        detection_pool.extend(
            detections
                .iter()
                .enumerate()
                .filter(|(_, detection)| detection.confidence >= config.high_confidence)
                .map(|(index, _)| index),
        );
        greedy_match(
            predictions,
            detections,
            detection_pool,
            track_taken,
            detection_taken,
            config.iou_match,
            pairs,
            matches,
        );

        // 3. Second association: whatever is still unmatched gets one more
        //    chance against the weak detections. This is the trick that keeps
        //    an id on a person the detector has half lost. A weak box may
        //    only continue a track - never start one - so the detection pool
        //    here is disjoint from the birth pool below.
        detection_pool.clear();
        detection_pool.extend(
            detections
                .iter()
                .enumerate()
                .filter(|(_, detection)| {
                    detection.confidence >= config.low_confidence
                        && detection.confidence < config.high_confidence
                })
                .map(|(index, _)| index),
        );
        greedy_match(
            predictions,
            detections,
            detection_pool,
            track_taken,
            detection_taken,
            config.iou_match,
            pairs,
            matches,
        );

        let mut matched = Vec::with_capacity(matches.len());
        for &(track_index, detection_index) in matches.iter() {
            let track = &mut tracks[track_index];
            track.observe(&detections[detection_index]);
            matched.push(Track {
                id: track.id,
                bbox: track.bbox,
                confidence: track.confidence,
            });
        }

        // 5. Death, run before birth purely so `track_taken` still indexes
        //    `tracks` one-to-one. `max_missed` is a budget of *unmatched*
        //    frames; exceeding it destroys the track for good. Ids are never
        //    recycled, so a person who returns after that is a genuinely new
        //    target and the UI is right to treat the old lock as lost.
        for (index, track) in tracks.iter_mut().enumerate() {
            if !track_taken[index] {
                track.missed += 1;
            }
        }
        tracks.retain(|track| track.missed <= config.max_missed);

        // 4. Birth. Only a confident, unclaimed detection earns an id.
        for (index, detection) in detections.iter().enumerate() {
            if detection_taken[index] || detection.confidence < config.high_confidence {
                continue;
            }
            *next_id += 1;
            tracks.push(LiveTrack {
                id: *next_id,
                bbox: detection.bbox,
                velocity: [0.0, 0.0],
                confidence: detection.confidence,
                missed: 0,
            });
        }

        // 6. Deterministic presentation order.
        matched.sort_by(|left, right| {
            right
                .confidence
                .total_cmp(&left.confidence)
                .then(left.id.cmp(&right.id))
        });
        matched
    }
}

/// Greedy IoU assignment. Candidate tracks are the ones not yet taken this
/// frame; candidate detections are `detection_pool` minus anything already
/// taken. Accepted pairs are appended to `matches` and marked taken, so the
/// two association passes compose without any extra bookkeeping.
///
/// Greedy rather than Hungarian on purpose: the frame holds a handful of
/// people, the gate at `iou_match` already rejects everything implausible, and
/// an O(n^2 log n) sort with no allocation beats an optimal assignment nobody
/// can see the difference from.
#[allow(clippy::too_many_arguments)]
fn greedy_match(
    predictions: &[[f32; 4]],
    detections: &[Observation],
    detection_pool: &[usize],
    track_taken: &mut [bool],
    detection_taken: &mut [bool],
    iou_match: f32,
    pairs: &mut Vec<(f32, usize, usize)>,
    matches: &mut Vec<(usize, usize)>,
) {
    pairs.clear();
    for (track_index, prediction) in predictions.iter().enumerate() {
        if track_taken[track_index] {
            continue;
        }
        for &detection_index in detection_pool {
            if detection_taken[detection_index] {
                continue;
            }
            let score = iou(prediction, &detections[detection_index].bbox);
            if score >= iou_match {
                pairs.push((score, track_index, detection_index));
            }
        }
    }
    // Descending overlap. The index tiebreaks make the outcome independent of
    // the order the pairs happened to be generated in, which is what keeps the
    // tests - and the ids the operator sees - reproducible.
    pairs.sort_by(|left, right| {
        right
            .0
            .total_cmp(&left.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });
    for &(_, track_index, detection_index) in pairs.iter() {
        if track_taken[track_index] || detection_taken[detection_index] {
            continue;
        }
        track_taken[track_index] = true;
        detection_taken[detection_index] = true;
        matches.push((track_index, detection_index));
    }
}

fn centre(bbox: &[f32; 4]) -> [f32; 2] {
    [bbox[0] + bbox[2] * 0.5, bbox[1] + bbox[3] * 0.5]
}

fn iou(left: &[f32; 4], right: &[f32; 4]) -> f32 {
    let x0 = left[0].max(right[0]);
    let y0 = left[1].max(right[1]);
    let x1 = (left[0] + left[2]).min(right[0] + right[2]);
    let y1 = (left[1] + left[3]).min(right[1] + right[3]);
    let width = x1 - x0;
    let height = y1 - y0;
    if width <= 0.0 || height <= 0.0 {
        return 0.0;
    }
    let intersection = width * height;
    let union = left[2] * left[3] + right[2] * right[3] - intersection;
    if union <= 0.0 {
        return 0.0;
    }
    intersection / union
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker() -> Tracker {
        Tracker::new(TrackerConfig::default())
    }

    /// `[x, y, w, h]` from a centre, which is how a walking person is easiest
    /// to describe frame by frame.
    fn centred(cx: f32, cy: f32, width: f32, height: f32) -> [f32; 4] {
        [cx - width * 0.5, cy - height * 0.5, width, height]
    }

    fn seen(bbox: [f32; 4], confidence: f32) -> Observation {
        Observation { bbox, confidence }
    }

    #[test]
    fn a_steadily_moving_person_keeps_one_id() {
        let mut tracker = tracker();
        let mut ids = Vec::new();
        for frame in 0..40 {
            let bbox = centred(60.0 + 12.0 * frame as f32, 360.0, 80.0, 220.0);
            let tracks = tracker.update(&[seen(bbox, 0.85)]);
            // The birth frame is withheld; every frame after it reports.
            if frame == 0 {
                assert!(tracks.is_empty(), "a newborn track is not emitted");
                continue;
            }
            assert_eq!(tracks.len(), 1);
            assert_eq!(tracks[0].bbox, bbox, "the measurement, not the prediction");
            ids.push(tracks[0].id);
        }
        assert_eq!(ids.len(), 39);
        assert!(ids.iter().all(|id| *id == ids[0]), "id churned: {ids:?}");
    }

    #[test]
    fn two_people_crossing_do_not_swap_ids() {
        let mut tracker = tracker();
        // Different builds, walking through each other. Even at the moment
        // their centres coincide the size difference keeps the correct pairing
        // strictly the highest-IoU one, which is what greedy assignment needs.
        let left_of = |frame: f32| centred(30.0 + 12.0 * frame, 160.0, 60.0, 120.0);
        let right_of = |frame: f32| centred(330.0 - 12.0 * frame, 160.0, 44.0, 160.0);

        let mut left_id = None;
        let mut right_id = None;
        let mut crossed = false;
        for frame in 0..25 {
            let left = left_of(frame as f32);
            let right = right_of(frame as f32);
            if iou(&left, &right) > 0.4 {
                crossed = true;
            }
            let tracks = tracker.update(&[seen(left, 0.9), seen(right, 0.8)]);
            if frame == 0 {
                continue;
            }
            assert_eq!(tracks.len(), 2, "frame {frame}");
            let for_left = tracks
                .iter()
                .find(|track| track.bbox == left)
                .unwrap_or_else(|| panic!("left box unmatched on frame {frame}"));
            let for_right = tracks
                .iter()
                .find(|track| track.bbox == right)
                .unwrap_or_else(|| panic!("right box unmatched on frame {frame}"));
            let left_id = *left_id.get_or_insert(for_left.id);
            let right_id = *right_id.get_or_insert(for_right.id);
            assert_eq!(for_left.id, left_id, "left id swapped on frame {frame}");
            assert_eq!(for_right.id, right_id, "right id swapped on frame {frame}");
        }
        assert!(
            crossed,
            "the fixture never actually overlapped the two boxes"
        );
    }

    #[test]
    fn a_dip_into_low_confidence_keeps_the_id() {
        let mut tracker = tracker();
        let bbox_at = |frame: f32| centred(100.0 + 10.0 * frame, 300.0, 70.0, 200.0);

        tracker.update(&[seen(bbox_at(0.0), 0.9)]);
        let established = tracker.update(&[seen(bbox_at(1.0), 0.9)]);
        let id = established[0].id;

        // Half occluded: the detector still fires, just weakly. ByteTrack's
        // second pass is the only reason this survives.
        for frame in 2..6 {
            let tracks = tracker.update(&[seen(bbox_at(frame as f32), 0.18)]);
            assert_eq!(tracks.len(), 1, "frame {frame}");
            assert_eq!(tracks[0].id, id, "id lost to a weak detection");
            assert!((tracks[0].confidence - 0.18).abs() < f32::EPSILON);
        }

        let recovered = tracker.update(&[seen(bbox_at(6.0), 0.95)]);
        assert_eq!(recovered[0].id, id);
    }

    #[test]
    fn a_weak_detection_alone_never_creates_a_track() {
        let mut tracker = tracker();
        let bbox = centred(200.0, 200.0, 80.0, 180.0);
        for _ in 0..10 {
            assert!(tracker.update(&[seen(bbox, 0.2)]).is_empty());
        }
        // Below the low floor the detector output is not even association fuel.
        for _ in 0..10 {
            assert!(tracker.update(&[seen(bbox, 0.05)]).is_empty());
        }
    }

    #[test]
    fn a_long_absence_ends_the_track_and_the_id_is_never_reused() {
        let config = TrackerConfig::default();
        let bbox = centred(400.0, 300.0, 90.0, 210.0);

        // Exactly `max_missed` blank frames is survivable: same id returns.
        let mut tracker = Tracker::new(config);
        tracker.update(&[seen(bbox, 0.9)]);
        let first = tracker.update(&[seen(bbox, 0.9)])[0].id;
        for _ in 0..config.max_missed {
            assert!(tracker.update(&[]).is_empty());
        }
        assert_eq!(tracker.update(&[seen(bbox, 0.9)])[0].id, first);

        // One frame more and the track is destroyed, so the identical box
        // comes back as a different person with a fresh id.
        let mut tracker = Tracker::new(config);
        tracker.update(&[seen(bbox, 0.9)]);
        let first = tracker.update(&[seen(bbox, 0.9)])[0].id;
        for _ in 0..=config.max_missed {
            assert!(tracker.update(&[]).is_empty());
        }
        assert!(
            tracker.update(&[seen(bbox, 0.9)]).is_empty(),
            "the re-detection is a birth, and a birth is withheld one frame"
        );
        let reborn = tracker.update(&[seen(bbox, 0.9)]);
        assert_eq!(reborn.len(), 1);
        assert_ne!(reborn[0].id, first, "an id was recycled");
        assert!(reborn[0].id > first, "ids must increase monotonically");
    }

    #[test]
    fn an_unmatched_track_is_never_returned() {
        let mut tracker = tracker();
        let bbox = centred(300.0, 300.0, 80.0, 200.0);
        tracker.update(&[seen(bbox, 0.9)]);
        assert_eq!(tracker.update(&[seen(bbox, 0.9)]).len(), 1);

        // Nothing detected: nothing emitted, even though the track lives on.
        assert!(tracker.update(&[]).is_empty());
        // A detection far outside the gate is a birth, not a continuation, so
        // the coasting track still contributes no box.
        let elsewhere = centred(900.0, 100.0, 40.0, 90.0);
        assert!(tracker.update(&[seen(elsewhere, 0.9)]).is_empty());
        // And the surviving original re-attaches to its own measurement only.
        let resumed = tracker.update(&[seen(bbox, 0.9)]);
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].bbox, bbox);
    }

    #[test]
    fn output_is_highest_confidence_first() {
        let mut tracker = tracker();
        let low = centred(100.0, 300.0, 80.0, 200.0);
        let high = centred(500.0, 300.0, 80.0, 200.0);
        tracker.update(&[seen(low, 0.55), seen(high, 0.95)]);
        let tracks = tracker.update(&[seen(low, 0.55), seen(high, 0.95)]);
        assert_eq!(tracks.len(), 2);
        assert!(tracks[0].confidence >= tracks[1].confidence);
        assert_eq!(tracks[0].bbox, high);
    }

    #[test]
    fn reset_drops_every_track_without_recycling_ids() {
        let mut tracker = tracker();
        let bbox = centred(300.0, 300.0, 80.0, 200.0);
        tracker.update(&[seen(bbox, 0.9)]);
        let first = tracker.update(&[seen(bbox, 0.9)])[0].id;

        tracker.reset();
        tracker.update(&[seen(bbox, 0.9)]);
        let after = tracker.update(&[seen(bbox, 0.9)])[0].id;
        assert!(after > first, "a new session must not inherit a stale id");
    }
}
