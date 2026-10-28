import { describe, expect, it } from 'vitest';
import { ExerciseEngine, jointAngle, simulatedPose } from './engine';
import type { Point } from './types';

function kneePose(angle: number): Point[] {
  const points = simulatedPose(0, 'squat');
  const radians = (angle * Math.PI) / 180;
  points[23] = {
    x: 0.5 + Math.sin(radians) * 0.2,
    y: 0.6 + Math.cos(radians) * 0.2,
    visibility: 1,
  };
  points[25] = { x: 0.5, y: 0.6, visibility: 1 };
  points[27] = { x: 0.5, y: 0.9, visibility: 1 };
  points[11].visibility = 0;
  return points;
}

function cycle(engine: ExerciseEngine, minimum: number, start = 0) {
  let result = engine.update(kneePose(180), start);
  for (let elapsed = 50; elapsed <= 3000; elapsed += 50) {
    const angle = 180 - ((180 - minimum) * (1 - Math.cos((elapsed / 3000) * Math.PI * 2))) / 2;
    result = engine.update(kneePose(angle), start + elapsed);
  }
  return result;
}
describe('exercise engine', () => {
  it('computes joint angle and rejects degenerate geometry', () => {
    expect(jointAngle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBeCloseTo(90);
    expect(jointAngle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNaN();
  });
  it('restores the same physical angle across different image aspect ratios', () => {
    const a = { x: 0.25, y: 0.25 },
      b = { x: 0.5, y: 0.5 },
      c = { x: 0.5, y: 0.75 };
    const stretched = [a, b, c].map((p) => ({ x: p.x / 2, y: p.y }));
    expect(jointAngle(...(stretched as [Point, Point, Point]), 2)).toBeCloseTo(jointAngle(a, b, c));
    expect(jointAngle(a, b, c, 0)).toBeNaN();
  });
  it('counts a shallower cycle but grades its amplitude separately', () => {
    const result = cycle(new ExerciseEngine('squat'), 120);
    expect(result.reps).toBe(1);
    expect(result.squatReps[0].rom).toBe('below_rule');
    expect(result.squatReps[0].descent_seconds).toBeGreaterThan(0);
    expect(result.squatReps[0].ascent_seconds).toBeGreaterThan(0);
    const rep = result.squatReps[0];
    expect(rep.descent_seconds + rep.ascent_seconds).toBeCloseTo(
      rep.end_seconds - rep.start_seconds,
    );
  });
  it('records a deeper cycle as reaching the experimental amplitude', () => {
    const result = cycle(new ExerciseEngine('squat'), 90);
    expect(result.squatReps[0].rom).toBe('within_rule');
  });
  it.each([90, 120])('cannot count a cycle when recording starts at %s degrees', (initialAngle) => {
    const engine = new ExerciseEngine('squat');
    let result;
    for (let t = 0; t < 1200; t += 50)
      result = engine.update(kneePose(t < 600 ? initialAngle : 180), t);
    expect(result!.reps).toBe(0);
  });
  it('a short observation gap gives an unknown grade instead of a failure', () => {
    const engine = new ExerciseEngine('squat');
    let result;
    for (let t = 0; t <= 3000; t += 50) {
      const angle = 180 - (90 * (1 - Math.cos((t / 3000) * Math.PI * 2))) / 2;
      result = engine.update(t === 1400 ? [] : kneePose(angle), t);
    }
    expect(result!.reps).toBe(1);
    expect(result!.squatReps[0].rom).toBe('unobservable');
  });
  it('cannot bridge dropped frames without an explicit invalid-pose message', () => {
    const engine = new ExerciseEngine('squat');
    for (let t = 0; t <= 1600; t += 50)
      engine.update(kneePose(180 - (90 * (1 - Math.cos((t / 3000) * Math.PI * 2))) / 2), t);
    let result;
    for (let t = 2400; t <= 3100; t += 50) result = engine.update(kneePose(180), t);
    expect(result!.reps).toBe(0);
  });
  it.each([
    ['squat', 3, 8],
    ['jumping_jack', 3, 12],
    ['pull_up', 3, 12],
    ['jump_rope', 8, 45],
    ['lunge', 3, 14],
    ['push_up', 3, 14],
    ['sit_up', 3, 14],
    ['high_knees', 6, 45],
    ['biceps_curl', 3, 16],
    ['overhead_press', 3, 16],
    ['plank', 1, 3],
    ['boxing', 6, 45],
  ] as const)('counts complete %s cycles', (exercise, min, max) => {
    const engine = new ExerciseEngine(exercise);
    let result;
    for (let t = 0; t < 12000; t += 50) result = engine.update(simulatedPose(t, exercise), t);
    expect(result!.reps).toBeGreaterThanOrEqual(min);
    expect(result!.reps).toBeLessThan(max);
  });
  it('does not count invisible poses', () => {
    const engine = new ExerciseEngine('squat');
    let result;
    for (let t = 0; t < 12000; t += 50)
      result = engine.update(
        simulatedPose(t, 'squat').map((p) => ({ ...p, visibility: 0 })),
        t,
      );
    expect(result!.reps).toBe(0);
    expect(result!.quality).toBe(false);
  });
  it('does not bridge a long tracking gap into a repetition', () => {
    const engine = new ExerciseEngine('squat');
    for (let t = 700; t < 1400; t += 50) engine.update(simulatedPose(1100, 'squat'), t);
    engine.update([], 1500);
    engine.update([], 2200);
    let result;
    for (let t = 2250; t < 3000; t += 50) result = engine.update(simulatedPose(0, 'squat'), t);
    expect(result!.reps).toBe(0);
  });
});

describe('LXF core observation regressions', () => {
  it.each(['squat', 'jumping_jack'] as const)('rejects nonnumeric %s coordinates', (exercise) => {
    const p = simulatedPose(0, exercise);
    (p[27] as unknown as { x: string }).x = '0.5';
    const result = new ExerciseEngine(exercise).update(p, 0);
    expect(result.quality).toBe(false);
    expect(result.unknown_reason).not.toBe('');
  });
  it('does not credit standing idle time to a too-fast jack cycle', () => {
    const e = new ExerciseEngine('jumping_jack');
    const closed = simulatedPose(0, 'jumping_jack');
    const open = structuredClone(closed);
    open[15].y = open[16].y = 0.1;
    open[27].x = 0.25;
    open[28].x = 0.75;
    for (let t = 0; t <= 2000; t += 50) e.update(closed, t);
    for (let t = 2050; t <= 2150; t += 50) e.update(open, t);
    let result;
    for (let t = 2200; t <= 2350; t += 50) result = e.update(closed, t);
    expect(result!.reps).toBe(0);
    // A subsequent complete, sufficiently long cycle still counts once.
    for (let t = 2400; t <= 3000; t += 50) e.update(open, t);
    for (let t = 3050; t <= 3200; t += 50) result = e.update(closed, t);
    expect(result!.reps).toBe(1);
  });
});

describe('LXF core acceptance matrix', () => {
  it.each(
    (['squat', 'jumping_jack'] as const).flatMap((exercise) =>
      [10, 15, 20, 30, 60].flatMap((fps) =>
        [1, 4 / 3, 16 / 9].map((aspect) => ({ exercise, fps, aspect })),
      ),
    ),
  )(
    'three complete $exercise cycles at $fps FPS, aspect $aspect',
    async ({ exercise, fps, aspect }) => {
      const { fixturePose } = await import('./replayFixtures');
      const engine = new ExerciseEngine(exercise);
      const duration = exercise === 'squat' ? 9000 : 4800;
      let result;
      for (let i = 0; i <= Math.round((duration * fps) / 1000); i++) {
        const time = (i * 1000) / fps;
        const points = fixturePose(time, exercise).map((p) => ({ ...p, x: p.x / aspect }));
        result = engine.update(points, time, aspect);
      }
      expect(result!.quality).toBe(true);
      expect(result!.reps).toBe(3);
    },
  );
  it.each(['squat', 'jumping_jack'] as const)(
    'long gap cancels $exercise then allows recovery',
    async (exercise) => {
      const { fixturePose } = await import('./replayFixtures');
      const engine = new ExerciseEngine(exercise);
      const duration = exercise === 'squat' ? 3000 : 1600;
      for (let t = 0; t <= duration / 2; t += 50) engine.update(fixturePose(t, exercise), t);
      // Both explicit invalid frames and the silent gap must discard the pending repetition.
      engine.update([], duration / 2 + 50);
      let result;
      for (let t = duration; t <= duration * 2; t += 50)
        result = engine.update(fixturePose(t, exercise), t);
      expect(result!.reps).toBe(1);
    },
  );
  it.each(['squat', 'jumping_jack'] as const)(
    'small stationary jitter cannot count $exercise',
    async (exercise) => {
      const { fixturePose } = await import('./replayFixtures');
      const engine = new ExerciseEngine(exercise);
      let result;
      for (let t = 0; t <= 10000; t += 50) {
        const points = fixturePose(0, exercise).map((p, i) => ({
          ...p,
          x: p.x + Math.sin(t / 100 + i) * 0.001,
          y: p.y + Math.cos(t / 100 + i) * 0.001,
        }));
        result = engine.update(points, t);
      }
      expect(result!.quality).toBe(true);
      expect(result!.reps).toBe(0);
    },
  );
});
