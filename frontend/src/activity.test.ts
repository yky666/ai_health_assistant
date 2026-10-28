import { describe, it, expect } from 'vitest';
import { ActivityTracker } from './activity';
import { simulatedPose } from './engine';
describe('causal movement segments', () => {
  it('stationary visible points are not exercise', () => {
    const tracker = new ActivityTracker(),
      p = simulatedPose(0, 'squat');
    expect(tracker.update(p, 0, true)).toBe('unknown');
    expect(tracker.update(p, 100, true)).toBe('rest');
  });
  it('counts movement and clears the movement latch after occlusion', () => {
    const tracker = new ActivityTracker();
    tracker.update(simulatedPose(0, 'squat'), 0, true);
    expect(tracker.update(simulatedPose(800, 'squat'), 100, true)).toBe('work');
    expect(tracker.update([], 200, false)).toBe('unknown');
    expect(tracker.update(simulatedPose(800, 'squat'), 300, true)).toBe('unknown');
    expect(tracker.update(simulatedPose(800, 'squat'), 400, true)).toBe('rest');
  });
  it('missing frames and non-increasing time cannot imply activity', () => {
    const tracker = new ActivityTracker(),
      p = simulatedPose(0, 'squat');
    tracker.update(p, 0, true);
    expect(tracker.update(p, 2000, true)).toBe('unknown');
    expect(tracker.update(p, 2000, true)).toBe('unknown');
    expect(tracker.update([], 2100, true)).toBe('unknown');
  });
});

describe('activity observation boundaries', () => {
  it('does not resume activity below the last accepted timestamp', () => {
    const tracker = new ActivityTracker();
    tracker.update(simulatedPose(0, 'squat'), 500, true);
    expect(tracker.update(simulatedPose(800, 'squat'), 100, true)).toBe('unknown');
    expect(tracker.update(simulatedPose(0, 'squat'), 200, true)).toBe('unknown');
    expect(tracker.update(simulatedPose(800, 'squat'), 300, true)).toBe('unknown');
    expect(tracker.update(simulatedPose(0, 'squat'), 600, true)).toBe('unknown');
    expect(tracker.update(simulatedPose(0, 'squat'), 700, true)).toBe('rest');
  });
  it('treats a changed image geometry as a new observation', () => {
    const tracker = new ActivityTracker();
    const p = simulatedPose(0, 'squat');
    tracker.update(p, 0, true, 1);
    const resized = p.map((v) => ({ ...v, x: v.x / 2 }));
    expect(tracker.update(resized, 100, true, 2)).toBe('unknown');
    expect(tracker.update(resized, 200, true, 2)).toBe('rest');
  });
  it('rejects negative timestamps', () => {
    const tracker = new ActivityTracker();
    const p = simulatedPose(0, 'squat');
    expect(tracker.update(p, -100, true)).toBe('unknown');
    expect(tracker.update(p, -50, true)).toBe('unknown');
  });
});
