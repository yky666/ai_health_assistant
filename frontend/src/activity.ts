import type { Point } from './types';
import contract from '../../shared/contract.json';

export type ActivityState = 'work' | 'rest' | 'unknown';
/** Causal movement heuristic, not a physiological intensity measurement. */
export class ActivityTracker {
  private previous: { points: Point[]; time: number; aspect: number } | null = null;
  private lastMovement = -Infinity;
  private lastSampleTime: number | null = null;
  update(points: Point[], time: number, quality: boolean, aspect = 1): ActivityState {
    const indices = [11, 12, 23, 24, 25, 26, 27, 28];
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      (this.lastSampleTime !== null && time <= this.lastSampleTime)
    ) {
      this.previous = null;
      this.lastMovement = -Infinity;
      return 'unknown';
    }
    this.lastSampleTime = time;
    if (!quality || !Number.isFinite(aspect) || aspect <= 0) {
      this.previous = null;
      this.lastMovement = -Infinity;
      return 'unknown';
    }
    const previous = this.previous;
    this.previous = { points: points.map((p) => ({ ...p })), time, aspect };
    if (
      !previous ||
      previous.aspect !== aspect ||
      time - previous.time > contract.pose.maximum_gap_ms
    ) {
      this.lastMovement = -Infinity;
      return 'unknown';
    }
    const usable = indices.filter(
      (i) =>
        points[i] &&
        previous.points[i] &&
        [points[i], previous.points[i]].every(
          (p) =>
            Number.isFinite(p.visibility) &&
            (p.visibility ?? 0) >= contract.pose.minimum_visibility &&
            Number.isFinite(p.x) &&
            Number.isFinite(p.y) &&
            p.x >= 0 &&
            p.x <= 1 &&
            p.y >= 0 &&
            p.y <= 1,
        ),
    );
    if (usable.length < 4) {
      this.lastMovement = -Infinity;
      return 'unknown';
    }
    const speed =
      usable.reduce(
        (sum, i) =>
          sum +
          Math.hypot(
            (points[i].x - previous.points[i].x) * aspect,
            points[i].y - previous.points[i].y,
          ),
        0,
      ) /
      usable.length /
      ((time - previous.time) / 1000);
    if (speed > 0.08) this.lastMovement = time;
    return time - this.lastMovement <= 400 ? 'work' : 'rest';
  }
}
