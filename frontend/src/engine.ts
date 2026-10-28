import { EXERCISES, type Exercise } from './catalog';
import type { Metrics, Point, SquatRep } from './types';
import contract from '../../shared/contract.json';
const poseRules = contract.pose;

export function jointAngle(a: Point, b: Point, c: Point, aspectRatio = 1): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return NaN;
  const ux = (a.x - b.x) * aspectRatio,
    uy = a.y - b.y,
    vx = (c.x - b.x) * aspectRatio,
    vy = c.y - b.y;
  const norm = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (norm < 1e-8) return NaN;
  return (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / norm))) * 180) / Math.PI;
}

const REQUIRED: Record<string, number[]> = {
  knee: [23, 25, 27],
  knee_jump: [23, 25, 27],
  split: [23, 24, 25, 26, 27, 28],
  side_split: [23, 24, 25, 26, 27, 28],
  bounce: [23, 24, 27, 28],
  hinge: [11, 23, 25, 27],
  bridge: [11, 12, 23, 24],
  side_leg: [23, 24, 27, 28],
  hold_squat: [23, 25, 27],
  push: [11, 13, 15, 23],
  vertical_pull: [0, 11, 12, 15, 16, 23, 24],
  dip: [11, 12, 15, 16, 23],
  curl: [11, 13, 15],
  press: [11, 12, 15, 16],
  raise_side: [11, 12, 15, 16],
  raise_front: [11, 12, 15, 16],
  tricep: [11, 13, 15],
  row: [11, 13, 15, 23],
  sit: [11, 12, 23, 24],
  crunch: [11, 12, 23, 24],
  hold_plank: [11, 12, 23, 24],
  climber: [11, 23, 25, 26],
  twist: [11, 12, 23, 24],
  open_close: [11, 12, 15, 16, 23, 24, 27, 28],
  rope: [11, 12, 15, 16, 23, 24, 25, 26],
  high_knee: [23, 24, 25, 26],
  jog: [23, 24, 25, 26],
  burpee: [11, 15, 23, 27],
  punch: [11, 12, 15, 16],
  circle: [11, 12, 15, 16],
};

export class ExerciseEngine {
  private reps = 0;
  private state = 'ready';
  private smoothed = 180;
  private lastRep = -Infinity;
  private lastEvent = -Infinity;
  private events = 0;
  private lostSince: number | null = null;
  private armed = false;
  private candidate: {
    start: number;
    bottom: number;
    minAngle: number;
    qualified: boolean;
    obscured: boolean;
  } | null = null;
  private squatReps: SquatRep[] = [];
  private lastSampleTime: number | null = null;
  private unknownReason = '';
  private qualityCode = 'observed';
  private jackPoseSince: number | null = null;
  private jackPose = '';
  private jackStart = 0;
  private dt = 0;
  private hipSmooth = 0.55;
  private hipMin = 0.55;
  private hipMax = 0.55;
  private holdMs = 0;
  private prevAng = NaN;
  private travel = 0;
  constructor(
    private exercise: Exercise,
    private downThreshold = 105,
  ) {}

  /** Drop an unfinished cycle at pause/seek/source boundaries, preserving completed reps. */
  interrupt() {
    this.candidate = null;
    this.armed = false;
    this.state = 'ready';
    this.smoothed = 180;
    this.holdMs = 0;
    this.jackPoseSince = null;
    this.jackPose = '';
    this.lastSampleTime = null;
    this.lostSince = null;
    this.prevAng = NaN;
    this.travel = 0;
  }

  update(points: Point[], time: number, aspectRatio = 1): Metrics {
    this.unknownReason = '';
    this.qualityCode = 'observed';
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      (this.lastSampleTime !== null && time <= this.lastSampleTime)
    ) {
      const previousTime = this.lastSampleTime;
      this.interrupt();
      this.lastSampleTime = previousTime;
      this.qualityCode = 'invalid_timestamp';
      this.unknownReason = '采样时间无效或未递增';
      return this.result(false, '等待连续有效采样；本次不评价动作。');
    }
    this.dt = this.lastSampleTime == null ? 0 : Math.max(0, time - this.lastSampleTime);
    if (this.lastSampleTime !== null && time - this.lastSampleTime > poseRules.maximum_gap_ms) {
      this.interrupt();
      this.dt = 0;
    }
    this.lastSampleTime = time;
    const family = EXERCISES[this.exercise].family;
    const needed = REQUIRED[family] ?? [11, 23, 25];
    const quality =
      Number.isFinite(aspectRatio) &&
      aspectRatio > 0 &&
      needed.every(
        (i) =>
          points[i] &&
          Number.isFinite(points[i].x) &&
          Number.isFinite(points[i].y) &&
          Number.isFinite(points[i].visibility) &&
          (points[i].visibility ?? 0) >= poseRules.minimum_visibility &&
          points[i].x >= 0 &&
          points[i].x <= 1 &&
          points[i].y >= 0 &&
          points[i].y <= 1,
      );
    if (!quality) {
      this.qualityCode =
        !Number.isFinite(aspectRatio) || aspectRatio <= 0
          ? 'invalid_aspect'
          : needed.some((i) => !points[i])
            ? 'missing_landmark'
            : needed.some(
                  (i) =>
                    !Number.isFinite(points[i].visibility) ||
                    (points[i].visibility ?? 0) < poseRules.minimum_visibility,
                )
              ? 'low_visibility'
              : 'out_of_frame';
      this.unknownReason =
        !Number.isFinite(aspectRatio) || aspectRatio <= 0
          ? '画面比例无效'
          : needed.some((i) => !points[i])
            ? '缺少所需关键点'
            : needed.some(
                  (i) =>
                    !Number.isFinite(points[i].visibility) ||
                    (points[i].visibility ?? 0) < poseRules.minimum_visibility,
                )
              ? '关键点可见性不足'
              : '所需关键点出画或坐标无效';
      if (this.candidate) this.candidate.obscured = true;
      if (family === 'open_close') {
        this.armed = false;
        this.state = 'ready';
        this.jackPoseSince = null;
        this.jackPose = '';
      }
      if (this.lostSince === null) this.lostSince = time;
      if (time - this.lostSince > poseRules.maximum_gap_ms) {
        this.state = 'ready';
        this.smoothed = 180;
        this.armed = false;
        this.candidate = null;
        this.holdMs = 0;
      }
      return this.result(false, '关键点不可见，请调整机位；暂停动作评价。');
    }
    if (this.lostSince !== null && time - this.lostSince > poseRules.maximum_gap_ms) {
      this.interrupt();
      this.dt = 0;
      this.lastSampleTime = time;
    }
    this.lostSince = null;
    if (family === 'knee' || family === 'knee_jump')
      return this.updateSquat(points, time, aspectRatio);
    if (family === 'open_close') return this.updateJumpingJack(points, time, aspectRatio);
    if (family === 'vertical_pull') return this.updatePullUp(points, time);
    if (family === 'rope') return this.updateBounce(points, time, true, 0.012);
    if (family === 'bounce') return this.updateBounce(points, time, false, 0.01);
    if (family === 'split') return this.updateLunge(points, time, aspectRatio, false);
    if (family === 'side_split') return this.updateLunge(points, time, aspectRatio, true);
    if (family === 'push') return this.updatePushUp(points, time);
    if (family === 'sit') return this.updateSit(points, time, 0.16);
    if (family === 'crunch') return this.updateSit(points, time, 0.08);
    if (family === 'hold_plank')
      return this.updateHold(
        Math.abs(points[11].y - points[23].y) < 0.16,
        '保持平板，身体一条线。',
        '请成俯撑，肩髋接近同一高度。',
      );
    if (family === 'hold_squat') {
      const knee = jointAngle(points[23], points[25], points[27], aspectRatio);
      return this.updateHold(knee < 130 && knee > 70, '保持静蹲。', '请屈膝靠墙，角度大约 90 度。');
    }
    if (family === 'high_knee') return this.updateHighKnees(points, time, 0.03);
    if (family === 'jog') return this.updateHighKnees(points, time, 0.012);
    if (family === 'climber') return this.updateClimber(points, time);
    if (family === 'curl')
      return this.updateElbow(
        points,
        time,
        11,
        13,
        15,
        80,
        145,
        aspectRatio,
        '屈肘抬起。',
        '伸直放下。',
      );
    if (family === 'tricep')
      return this.updateElbow(
        points,
        time,
        11,
        13,
        15,
        90,
        155,
        aspectRatio,
        '屈肘下放。',
        '在头顶伸直。',
      );
    if (family === 'press') return this.updatePress(points, time);
    if (family === 'raise_side') return this.updateRaise(points, time, aspectRatio, false);
    if (family === 'raise_front') return this.updateRaise(points, time, aspectRatio, true);
    if (family === 'hinge') return this.updateHinge(points, time, aspectRatio);
    if (family === 'row') return this.updateRow(points, time, aspectRatio);
    if (family === 'dip') return this.updateDip(points, time);
    if (family === 'bridge') return this.updateBridge(points, time);
    if (family === 'side_leg') return this.updateSideLeg(points, time, aspectRatio);
    if (family === 'burpee') return this.updateBurpee(points, time);
    if (family === 'punch') return this.updatePunch(points, time, aspectRatio);
    if (family === 'twist') return this.updateTwist(points, time, aspectRatio);
    if (family === 'circle') return this.updateCircle(points, time, aspectRatio);
    return this.updateBounce(points, time, false, 0.012);
  }

  private countCycle(
    down: boolean,
    up: boolean,
    time: number,
    gap: number,
    downHint: string,
    upHint: string,
    done: string,
  ): Metrics {
    if (down) {
      this.armed = true;
      if (this.state === 'up' && time - this.lastRep > gap) {
        this.reps++;
        this.lastRep = time;
        this.state = 'down';
        return this.result(true, done);
      }
      this.state = 'down';
      return this.result(true, downHint);
    }
    if (this.armed && up) {
      this.state = 'up';
      return this.result(true, upHint);
    }
    return this.result(true, downHint);
  }

  private updateHold(ok: boolean, okHint: string, badHint: string): Metrics {
    if (!ok) {
      this.holdMs = 0;
      this.state = 'ready';
      return this.result(true, badHint);
    }
    this.holdMs += this.dt;
    this.smoothed = this.holdMs / 80;
    this.state = 'hold';
    if (this.holdMs >= 8000) {
      this.reps++;
      this.holdMs = 0;
      return this.result(true, `${okHint} 已累计 8 秒。`);
    }
    return this.result(true, `${okHint} 已保持 ${(this.holdMs / 1000).toFixed(1)} 秒。`);
  }

  private updateSquat(points: Point[], time: number, aspectRatio: number): Metrics {
    let hint: string = EXERCISES[this.exercise].hint;
    const raw = jointAngle(points[23], points[25], points[27], aspectRatio);
    if (!Number.isFinite(raw)) {
      this.interrupt();
      this.qualityCode = 'degenerate_geometry';
      return this.result(false, '无法估计关节角度，请调整机位。');
    }
    const retention = this.dt > 0 ? Math.pow(0.6, this.dt / 50) : 0;
    this.smoothed = this.smoothed * retention + raw * (1 - retention);
    const countThreshold = Math.min(145, this.downThreshold + 25);
    if (this.armed && this.smoothed < 150 && !this.candidate) {
      this.candidate = {
        start: time,
        bottom: time,
        minAngle: this.smoothed,
        qualified: false,
        obscured: false,
      };
    }
    if (this.candidate) {
      if (this.smoothed < this.candidate.minAngle) {
        this.candidate.minAngle = this.smoothed;
        this.candidate.bottom = time;
      }
      if (this.smoothed < countThreshold) {
        this.candidate.qualified = true;
        this.state = 'down';
      }
    }
    if (this.smoothed > 155 && raw > 155) {
      const cycle = this.candidate;
      if (cycle?.qualified && time - cycle.start >= 700 && time - this.lastRep > 700) {
        this.reps++;
        this.lastRep = time;
        if (this.exercise === 'squat') {
          this.squatReps.push({
            number: this.reps,
            start_seconds: cycle.start / 1000,
            bottom_seconds: cycle.bottom / 1000,
            end_seconds: time / 1000,
            descent_seconds: (cycle.bottom - cycle.start) / 1000,
            ascent_seconds: (time - cycle.bottom) / 1000,
            min_angle_degrees: Math.round(cycle.minAngle * 10) / 10,
            rom: cycle.obscured
              ? 'unobservable'
              : cycle.minAngle <= this.downThreshold
                ? 'within_rule'
                : 'below_rule',
          });
          if (this.squatReps.length > 100) this.squatReps.shift();
        }
      }
      this.candidate = null;
      this.armed = true;
      this.state = 'ready';
      hint = '回到站立。';
    }
    if (points[11] && (points[11].visibility ?? 0) >= 0.65) {
      const dx = Math.abs(points[11].x - points[23].x) * aspectRatio;
      const dy = Math.abs(points[11].y - points[23].y);
      if (dx > dy * 0.9) {
        hint = '躯干倾斜较明显，请检查机位与动作；此提示采用待验证规则。';
        if (time - this.lastEvent > 4000) {
          this.events++;
          this.lastEvent = time;
        }
      }
    }
    return this.result(true, hint);
  }

  private updateJumpingJack(points: Point[], time: number, aspectRatio: number): Metrics {
    const hipW = Math.abs(points[23].x - points[24].x) * aspectRatio;
    if (hipW < poseRules.jack_min_hip_width) {
      this.interrupt();
      this.qualityCode = 'view_unreliable';
      this.unknownReason = '髋部投影过窄，可能侧身或距离过远';
      return this.result(false, '请正面朝向摄像头并让全身入画，再从并拢姿态开始。');
    }
    const footW = Math.abs(points[27].x - points[28].x) * aspectRatio;
    const spread = footW / hipW;
    const handsHigh = points[15].y < points[11].y - 0.04 && points[16].y < points[12].y - 0.04;
    const handsLow = points[15].y > points[11].y + 0.1 && points[16].y > points[12].y + 0.1;
    const feetOpen = spread > 1.65;
    const feetClosed = spread < 1.28;
    this.smoothed = spread * 50;
    const pose = handsLow && feetClosed ? 'closed' : handsHigh && feetOpen ? 'open' : 'transition';
    if (pose !== this.jackPose) {
      this.jackPose = pose;
      this.jackPoseSince = time;
    }
    const stable =
      this.jackPoseSince !== null && time - this.jackPoseSince >= poseRules.jack_dwell_ms;
    if (handsLow && feetClosed) {
      if (!stable) return this.result(true, '正在确认并拢姿态。');
      if (
        this.state === 'open' &&
        time - this.jackStart >= poseRules.jack_cycle_ms &&
        time - this.lastRep > poseRules.jack_cycle_ms
      ) {
        this.reps++;
        this.lastRep = time;
        this.state = 'ready';
        this.jackStart = time;
        return this.result(true, '完成一次开合。手臂过头、双脚打开后再收回。');
      }
      // Start from the latest confirmed closed endpoint; idle time is not a cycle.
      this.jackStart = time;
      this.armed = true;
      this.state = 'ready';
      return this.result(true, '双手放体侧、双脚并拢，准备下一次打开。');
    }
    if (this.armed && handsHigh && feetOpen && stable) {
      this.state = 'open';
      return this.result(true, '打开：手臂上举，双脚同时分开。');
    }
    if (handsHigh && !feetOpen) return this.result(true, '手臂已抬起，请同时把双脚分开。');
    if (feetOpen && !handsHigh) return this.result(true, '双脚已分开，请把双手举过肩膀。');
    return this.result(true, '开合跳要手脚同时打开再同时收回，正面全身入画。');
  }

  private updatePullUp(points: Point[], time: number): Metrics {
    const wristY = (points[15].y + points[16].y) / 2;
    const shoulderY = (points[11].y + points[12].y) / 2;
    const hipY = (points[23].y + points[24].y) / 2;
    const torso = Math.max(hipY - shoulderY, 0.08);
    const hang = (shoulderY - wristY) / torso;
    this.smoothed = Math.round(hang * 100);
    const onBar = wristY < shoulderY - 0.02;
    if (!onBar) {
      this.armed = false;
      this.state = 'ready';
      return this.result(true, '请双手抓住横杆，手腕应高于肩膀。');
    }
    return this.countCycle(
      hang > 0.95,
      hang < 0.45,
      time,
      600,
      '悬垂已看到。向上拉，让肩膀靠近手腕。',
      '拉到高点，再控制下放。',
      '回到悬垂，完成一次。',
    );
  }

  private updateBounce(points: Point[], time: number, rope: boolean, minAmp: number): Metrics {
    const hipY = (points[23].y + points[24].y) / 2;
    this.hipSmooth = this.hipSmooth * 0.65 + hipY * 0.35;
    this.hipMin = Math.min(this.hipMin * 0.995 + this.hipSmooth * 0.005, this.hipSmooth);
    this.hipMax = Math.max(this.hipMax * 0.995 + this.hipSmooth * 0.005, this.hipSmooth);
    const amp = this.hipMax - this.hipMin;
    this.smoothed = Math.round(amp * 1000);
    if (rope && !(points[15].y > points[11].y && points[16].y > points[12].y)) {
      return this.result(true, '跳绳时手腕应在腰侧摇绳，不要举过肩。');
    }
    if (amp < minAmp)
      return this.result(true, rope ? '请小幅度连续跳起。' : '请踮脚向上，再轻轻落下。');
    const up = this.hipSmooth < this.hipMin + amp * 0.35;
    const down = this.hipSmooth > this.hipMax - amp * 0.35;
    const dt = this.lastRep === -Infinity ? 400 : time - this.lastRep;
    if (up) this.state = 'air';
    if (this.state === 'air' && down && dt > 240 && dt < 900) {
      this.reps++;
      this.lastRep = time;
      this.state = 'ready';
      return this.result(true, rope ? '着地一次。保持轻快节奏。' : '脚跟落下，完成一次提踵。');
    }
    if (this.state === 'air' && down && dt >= 900) this.state = 'ready';
    return this.result(true, this.state === 'air' ? '在高点。' : EXERCISES[this.exercise].hint);
  }

  private updateLunge(points: Point[], time: number, aspect: number, side: boolean): Metrics {
    const split = Math.abs(points[27].x - points[28].x) * aspect;
    const enough = side ? split > 0.16 : split > 0.14;
    const hip = (points[23].y + points[24].y) / 2;
    this.smoothed = hip * 180;
    if (!enough)
      return this.result(true, side ? '请向一侧迈出足够步幅。' : '请前后分腿，步幅大一些。');
    return this.countCycle(
      hip > 0.58,
      hip < 0.54,
      time,
      450,
      '下到弓步。',
      '蹬回站立。',
      '完成一次弓步。',
    );
  }

  private updatePushUp(points: Point[], time: number): Metrics {
    const flat = Math.abs(points[11].y - points[23].y) < 0.16;
    this.smoothed = points[11].y * 180;
    if (!flat) return this.result(true, '请成一条直线俯撑，肩髋接近同一高度。');
    return this.countCycle(
      points[11].y > 0.48,
      points[11].y < 0.4,
      time,
      450,
      '下降，胸部靠近地面。',
      '撑起。',
      '完成一次俯卧撑。',
    );
  }

  private updateSit(points: Point[], time: number, rise: number): Metrics {
    const lift = points[23].y - points[11].y;
    this.smoothed = lift * 200;
    return this.countCycle(
      lift > rise,
      lift < rise * 0.35,
      time,
      450,
      '躺下或回到起点。',
      '肩离地坐起。',
      '完成一次。',
    );
  }

  private updateHighKnees(points: Point[], time: number, margin: number): Metrics {
    const left = points[25].y < points[23].y - margin;
    const right = points[26].y < points[24].y - margin;
    this.smoothed = (left ? 80 : 0) + (right ? 80 : 0);
    if (left && !right && this.state === 'right' && time - this.lastRep > 180) {
      this.reps++;
      this.lastRep = time;
      this.state = 'left';
      return this.result(true, '左膝抬起。');
    }
    if (right && !left && this.state === 'left' && time - this.lastRep > 180) {
      this.reps++;
      this.lastRep = time;
      this.state = 'right';
      return this.result(true, '右膝抬起。');
    }
    if (left && !right) this.state = 'left';
    if (right && !left) this.state = 'right';
    return this.result(true, EXERCISES[this.exercise].hint);
  }

  private updateClimber(points: Point[], time: number): Metrics {
    if (Math.abs(points[11].y - points[23].y) > 0.2)
      return this.result(true, '先保持俯撑，再交替收膝。');
    return this.updateHighKnees(points, time, 0.02);
  }

  private updateElbow(
    points: Point[],
    time: number,
    a: number,
    b: number,
    c: number,
    down: number,
    up: number,
    aspect: number,
    dHint: string,
    uHint: string,
  ): Metrics {
    const angle = jointAngle(points[a], points[b], points[c], aspect);
    if (!Number.isFinite(angle)) return this.result(false, '看不清肘关节。');
    this.smoothed = angle;
    return this.countCycle(angle < down, angle > up, time, 400, dHint, uHint, '完成一次。');
  }

  private updatePress(points: Point[], time: number): Metrics {
    const wrist = (points[15].y + points[16].y) / 2;
    const shoulder = (points[11].y + points[12].y) / 2;
    this.smoothed = (shoulder - wrist) * 200;
    return this.countCycle(
      wrist > shoulder - 0.02,
      wrist < shoulder - 0.14,
      time,
      400,
      '回到肩上。',
      '推过头顶。',
      '完成一次推举。',
    );
  }

  private updateRaise(points: Point[], time: number, aspect: number, front: boolean): Metrics {
    const height = (points[11].y + points[12].y) / 2 - (points[15].y + points[16].y) / 2;
    const spread = Math.abs(points[15].x - points[16].x) * aspect;
    this.smoothed = height * 200;
    const up = front ? height > 0.02 && spread < 0.28 : height > -0.02 && spread > 0.32;
    const down = height < -0.12;
    return this.countCycle(down, up, time, 400, '手臂回落到体侧。', '举到肩高。', '完成一次平举。');
  }

  private updateHinge(points: Point[], time: number, aspect: number): Metrics {
    const torso = jointAngle(points[11], points[23], points[25], aspect);
    const knee = jointAngle(points[23], points[25], points[27], aspect);
    this.smoothed = torso;
    if (knee < 140) return this.result(true, '膝盖不要蹲得太深，这是髋铰链。');
    return this.countCycle(
      torso < 130,
      torso > 155,
      time,
      500,
      '臀部后推。',
      '站直到髋伸展。',
      '完成一次硬拉。',
    );
  }

  private updateRow(points: Point[], time: number, aspect: number): Metrics {
    const elbow = jointAngle(points[11], points[13], points[15], aspect);
    this.smoothed = elbow;
    return this.countCycle(
      elbow < 90,
      elbow > 140,
      time,
      400,
      '手臂伸直。',
      '肘向后拉。',
      '完成一次划船。',
    );
  }

  private updateDip(points: Point[], time: number): Metrics {
    const wrist = (points[15].y + points[16].y) / 2;
    const shoulder = (points[11].y + points[12].y) / 2;
    this.smoothed = (shoulder - wrist) * 200;
    return this.countCycle(
      shoulder > wrist + 0.08,
      shoulder < wrist + 0.03,
      time,
      450,
      '身体下降。',
      '撑起。',
      '完成一次臂屈伸。',
    );
  }

  private updateBridge(points: Point[], time: number): Metrics {
    const hip = (points[23].y + points[24].y) / 2;
    const shoulder = (points[11].y + points[12].y) / 2;
    if (shoulder < 0.42) return this.result(true, '请仰卧，肩膀靠近画面下方。');
    this.smoothed = (shoulder - hip) * 200;
    return this.countCycle(
      hip > shoulder - 0.02,
      hip < shoulder - 0.1,
      time,
      450,
      '臀部放下。',
      '把髋顶起。',
      '完成一次臀桥。',
    );
  }

  private updateSideLeg(points: Point[], time: number, aspect: number): Metrics {
    const hipW = Math.max(Math.abs(points[23].x - points[24].x) * aspect, 0.05);
    const footW = Math.abs(points[27].x - points[28].x) * aspect;
    const spread = footW / hipW;
    this.smoothed = spread * 40;
    return this.countCycle(
      spread < 1.3,
      spread > 2.1,
      time,
      400,
      '腿收回。',
      '向外抬腿。',
      '完成一次侧抬腿。',
    );
  }

  private updateBurpee(points: Point[], time: number): Metrics {
    const hip = (points[23].y + points[24].y) / 2;
    const handsDown = points[15].y > 0.7 && points[27].y > 0.78;
    const stand = hip < 0.58 && points[15].y < 0.62;
    const jump = hip < 0.48;
    this.smoothed = hip * 180;
    if (handsDown)
      this.state = this.state === 'ready' || this.state === 'jump' ? 'down' : this.state;
    if (this.state === 'down' && stand) this.state = 'stand';
    if (this.state === 'stand' && jump && time - this.lastRep > 700) {
      this.reps++;
      this.lastRep = time;
      this.state = 'jump';
      return this.result(true, '跳起，完成一次波比。');
    }
    if (stand && !jump) this.state = this.state === 'jump' ? 'ready' : this.state;
    return this.result(true, '下蹲撑地，再站起跳起。');
  }

  private updatePunch(points: Point[], time: number, aspect: number): Metrics {
    const left = (points[11].x - points[15].x) * aspect;
    const right = (points[16].x - points[12].x) * aspect;
    this.smoothed = Math.max(left, right) * 200;
    const L = left > 0.12;
    const R = right > 0.12;
    if (L && !R && this.state === 'right' && time - this.lastRep > 180) {
      this.reps++;
      this.lastRep = time;
      this.state = 'left';
      return this.result(true, '左拳。');
    }
    if (R && !L && this.state === 'left' && time - this.lastRep > 180) {
      this.reps++;
      this.lastRep = time;
      this.state = 'right';
      return this.result(true, '右拳。');
    }
    if (L && !R) this.state = 'left';
    if (R && !L) this.state = 'right';
    return this.result(true, '左右交替出拳。');
  }

  private updateTwist(points: Point[], time: number, aspect: number): Metrics {
    const rot = ((points[11].x + points[12].x) / 2 - (points[23].x + points[24].x) / 2) * aspect;
    this.smoothed = rot * 200;
    if (rot < -0.04 && this.state === 'right' && time - this.lastRep > 280) {
      this.reps++;
      this.lastRep = time;
      this.state = 'left';
      return this.result(true, '转向左侧。');
    }
    if (rot > 0.04 && this.state === 'left' && time - this.lastRep > 280) {
      this.reps++;
      this.lastRep = time;
      this.state = 'right';
      return this.result(true, '转向右侧。');
    }
    if (rot < -0.04) this.state = 'left';
    if (rot > 0.04) this.state = 'right';
    return this.result(true, '坐稳，左右转肩。');
  }

  private updateCircle(points: Point[], time: number, aspect: number): Metrics {
    const ang = Math.atan2(points[15].y - points[11].y, (points[15].x - points[11].x) * aspect);
    if (Number.isFinite(this.prevAng)) {
      let delta = ang - this.prevAng;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      this.travel += delta;
      if (Math.abs(this.travel) > Math.PI * 1.7 && time - this.lastRep > 250) {
        this.reps++;
        this.lastRep = time;
        this.travel = 0;
        this.prevAng = ang;
        this.smoothed = ((ang + Math.PI) * 180) / Math.PI;
        return this.result(true, '绕完一圈。');
      }
    }
    this.prevAng = ang;
    this.smoothed = ((ang + Math.PI) * 180) / Math.PI;
    return this.result(true, '双臂绕肩连续画圈。');
  }

  private result(quality: boolean, hint: string): Metrics {
    return {
      reps: this.reps,
      phase: this.state,
      quality,
      quality_status: quality ? 'observed' : 'unknown',
      quality_code: quality
        ? 'observed'
        : this.qualityCode === 'observed'
          ? 'degenerate_geometry'
          : this.qualityCode,
      unknown_reason: quality ? '' : this.unknownReason || '无法可靠计算当前动作几何',
      hint,
      angle: Math.round(this.smoothed),
      events: this.events,
      squatReps: [...this.squatReps],
    };
  }
}

function standing(): Point[] {
  const p: Point[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.25, visibility: 1 }));
  p[0] = { x: 0.5, y: 0.16, visibility: 1 };
  p[11] = { x: 0.44, y: 0.28, visibility: 1 };
  p[12] = { x: 0.56, y: 0.28, visibility: 1 };
  p[13] = { x: 0.36, y: 0.42, visibility: 1 };
  p[14] = { x: 0.64, y: 0.42, visibility: 1 };
  p[15] = { x: 0.32, y: 0.54, visibility: 1 };
  p[16] = { x: 0.68, y: 0.54, visibility: 1 };
  p[23] = { x: 0.46, y: 0.52, visibility: 1 };
  p[24] = { x: 0.54, y: 0.52, visibility: 1 };
  p[25] = { x: 0.46, y: 0.7, visibility: 1 };
  p[26] = { x: 0.54, y: 0.7, visibility: 1 };
  p[27] = { x: 0.46, y: 0.9, visibility: 1 };
  p[28] = { x: 0.54, y: 0.9, visibility: 1 };
  return p;
}

function wave(time: number, period: number) {
  return (1 - Math.cos((time / period) * Math.PI)) / 2;
}

export function simulatedPose(time: number, exercise: Exercise): Point[] {
  const p = standing();
  const w = wave(time, 550);
  const hop = wave(time, 280) * 0.05;
  if (exercise === 'jumping_jack') {
    const jack = wave(time, 550);
    const lift = jack * 0.035;
    p[0] = { x: 0.5, y: 0.16 - lift, visibility: 1 };
    p[11] = { x: 0.44, y: 0.28 - lift, visibility: 1 };
    p[12] = { x: 0.56, y: 0.28 - lift, visibility: 1 };
    p[13] = { x: 0.38 - jack * 0.12, y: 0.42 - lift - jack * 0.18, visibility: 1 };
    p[14] = { x: 0.62 + jack * 0.12, y: 0.42 - lift - jack * 0.18, visibility: 1 };
    p[15] = { x: 0.34 - jack * 0.16, y: 0.54 - lift - jack * 0.4, visibility: 1 };
    p[16] = { x: 0.66 + jack * 0.16, y: 0.54 - lift - jack * 0.4, visibility: 1 };
    p[23] = { x: 0.47 - jack * 0.02, y: 0.52 - lift, visibility: 1 };
    p[24] = { x: 0.53 + jack * 0.02, y: 0.52 - lift, visibility: 1 };
    p[25] = { x: 0.46 - jack * 0.1, y: 0.7 - lift, visibility: 1 };
    p[26] = { x: 0.54 + jack * 0.1, y: 0.7 - lift, visibility: 1 };
    p[27] = { x: 0.47 - jack * 0.17, y: 0.9 - lift, visibility: 1 };
    p[28] = { x: 0.53 + jack * 0.17, y: 0.9 - lift, visibility: 1 };
    return p;
  }
  if (exercise === 'pull_up') {
    const lift = wave(time, 700) * 0.16;
    p[15] = { x: 0.38, y: 0.12, visibility: 1 };
    p[16] = { x: 0.62, y: 0.12, visibility: 1 };
    p[11] = { x: 0.42, y: 0.38 - lift, visibility: 1 };
    p[12] = { x: 0.58, y: 0.38 - lift, visibility: 1 };
    p[0] = { x: 0.5, y: 0.24 - lift, visibility: 1 };
    p[23] = { x: 0.45, y: 0.62 - lift, visibility: 1 };
    p[24] = { x: 0.55, y: 0.62 - lift, visibility: 1 };
    p[25] = { x: 0.45, y: 0.74 - lift, visibility: 1 };
    p[26] = { x: 0.55, y: 0.74 - lift, visibility: 1 };
    p[27] = { x: 0.45, y: 0.9 - lift, visibility: 1 };
    p[28] = { x: 0.55, y: 0.9 - lift, visibility: 1 };
    return p;
  }
  if (exercise === 'jump_rope' || exercise === 'calf_raise') {
    const h = exercise === 'jump_rope' ? hop : wave(time, 320) * 0.04;
    for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28])
      p[i] = { ...p[i], y: p[i].y - h };
    return p;
  }
  if (exercise === 'lunge' || exercise === 'side_lunge') {
    const side = exercise === 'side_lunge';
    p[27] = { x: side ? 0.22 : 0.26, y: 0.9, visibility: 1 };
    p[28] = { x: side ? 0.78 : 0.62, y: 0.9, visibility: 1 };
    p[25] = { x: side ? 0.28 : 0.3, y: 0.64 + w * 0.04, visibility: 1 };
    p[26] = { x: side ? 0.7 : 0.6, y: 0.7, visibility: 1 };
    p[23] = { x: 0.48, y: 0.48 + w * 0.2, visibility: 1 };
    p[24] = { x: 0.56, y: 0.52, visibility: 1 };
    return p;
  }
  if (exercise === 'push_up' || exercise === 'mountain_climber' || exercise === 'plank') {
    const drop = exercise === 'plank' ? 0 : w * 0.14;
    p[15] = { x: 0.32, y: 0.42, visibility: 1 };
    p[16] = { x: 0.36, y: 0.42, visibility: 1 };
    p[13] = { x: 0.34, y: 0.42 + drop * 0.4, visibility: 1 };
    p[11] = { x: 0.4, y: 0.36 + drop, visibility: 1 };
    p[12] = { x: 0.48, y: 0.36 + drop, visibility: 1 };
    p[23] = { x: 0.62, y: 0.38 + drop, visibility: 1 };
    p[24] = { x: 0.68, y: 0.38 + drop, visibility: 1 };
    p[27] = { x: 0.78, y: 0.42, visibility: 1 };
    p[28] = { x: 0.82, y: 0.42, visibility: 1 };
    if (exercise === 'mountain_climber') {
      const left = Math.sin(time / 140) > 0;
      p[25] = { x: left ? 0.48 : 0.66, y: left ? 0.34 : 0.4, visibility: 1 };
      p[26] = { x: left ? 0.68 : 0.5, y: left ? 0.4 : 0.34, visibility: 1 };
    } else {
      p[25] = { x: 0.7, y: 0.4 + drop, visibility: 1 };
      p[26] = { x: 0.74, y: 0.4 + drop, visibility: 1 };
    }
    return p;
  }
  if (exercise === 'sit_up' || exercise === 'crunch') {
    const lift = exercise === 'sit_up' ? w * 0.22 : w * 0.1;
    p[11] = { x: 0.44, y: 0.62 - lift, visibility: 1 };
    p[12] = { x: 0.56, y: 0.62 - lift, visibility: 1 };
    p[23] = { x: 0.46, y: 0.62, visibility: 1 };
    p[24] = { x: 0.54, y: 0.62, visibility: 1 };
    p[27] = { x: 0.7, y: 0.62, visibility: 1 };
    p[28] = { x: 0.74, y: 0.62, visibility: 1 };
    return p;
  }
  if (exercise === 'high_knees' || exercise === 'running_in_place') {
    const left = Math.sin(time / 140) > 0;
    const lift = exercise === 'high_knees' ? 0.28 : 0.16;
    p[25] = { x: 0.46, y: left ? 0.7 - lift : 0.7, visibility: 1 };
    p[26] = { x: 0.54, y: left ? 0.7 : 0.7 - lift, visibility: 1 };
    p[27] = { x: 0.46, y: left ? 0.82 : 0.9, visibility: 1 };
    p[28] = { x: 0.54, y: left ? 0.9 : 0.82, visibility: 1 };
    return p;
  }
  if (exercise === 'biceps_curl' || exercise === 'tricep_extension') {
    const curl = exercise === 'biceps_curl';
    p[15] = { x: 0.32, y: curl ? 0.54 - w * 0.22 : 0.12 + w * 0.16, visibility: 1 };
    p[13] = { x: 0.34, y: curl ? 0.42 : 0.2, visibility: 1 };
    p[11] = { x: 0.44, y: curl ? 0.28 : 0.22, visibility: 1 };
    return p;
  }
  if (exercise === 'overhead_press') {
    p[15] = { x: 0.38, y: 0.3 - w * 0.2, visibility: 1 };
    p[16] = { x: 0.62, y: 0.3 - w * 0.2, visibility: 1 };
    return p;
  }
  if (exercise === 'lateral_raise' || exercise === 'front_raise') {
    const side = exercise === 'lateral_raise';
    p[15] = { x: side ? 0.32 - w * 0.16 : 0.4, y: 0.54 - w * 0.24, visibility: 1 };
    p[16] = { x: side ? 0.68 + w * 0.16 : 0.46, y: 0.54 - w * 0.24, visibility: 1 };
    return p;
  }
  if (exercise === 'deadlift') {
    p[11] = { x: 0.44 + w * 0.08, y: 0.28 + w * 0.08, visibility: 1 };
    p[23] = { x: 0.46, y: 0.52, visibility: 1 };
    p[25] = { x: 0.46, y: 0.7, visibility: 1 };
    p[27] = { x: 0.46, y: 0.9, visibility: 1 };
    p[15] = { x: 0.4, y: 0.54 + w * 0.12, visibility: 1 };
    return p;
  }
  if (exercise === 'bent_over_row') {
    p[11] = { x: 0.5, y: 0.36, visibility: 1 };
    p[23] = { x: 0.46, y: 0.52, visibility: 1 };
    p[13] = { x: 0.4, y: 0.46 - w * 0.06, visibility: 1 };
    p[15] = { x: 0.34 + w * 0.08, y: 0.58 - w * 0.16, visibility: 1 };
    return p;
  }
  if (exercise === 'dip') {
    const drop = w * 0.1;
    p[15] = { x: 0.34, y: 0.34, visibility: 1 };
    p[16] = { x: 0.66, y: 0.34, visibility: 1 };
    p[11] = { x: 0.42, y: 0.32 + drop, visibility: 1 };
    p[12] = { x: 0.58, y: 0.32 + drop, visibility: 1 };
    p[23] = { x: 0.45, y: 0.56 + drop, visibility: 1 };
    p[24] = { x: 0.55, y: 0.56 + drop, visibility: 1 };
    return p;
  }
  if (exercise === 'glute_bridge') {
    p[11] = { x: 0.36, y: 0.7, visibility: 1 };
    p[12] = { x: 0.4, y: 0.7, visibility: 1 };
    p[23] = { x: 0.55, y: 0.7 - w * 0.16, visibility: 1 };
    p[24] = { x: 0.6, y: 0.7 - w * 0.16, visibility: 1 };
    p[27] = { x: 0.78, y: 0.7, visibility: 1 };
    p[28] = { x: 0.82, y: 0.7, visibility: 1 };
    return p;
  }
  if (exercise === 'hip_abduction') {
    p[28] = { x: 0.54 + w * 0.22, y: 0.86 - w * 0.08, visibility: 1 };
    p[26] = { x: 0.54 + w * 0.12, y: 0.7, visibility: 1 };
    return p;
  }
  if (exercise === 'wall_sit') {
    p[23] = { x: 0.5, y: 0.58, visibility: 1 };
    p[25] = { x: 0.5, y: 0.72, visibility: 1 };
    p[27] = { x: 0.5, y: 0.9, visibility: 1 };
    p[11] = { x: 0.5, y: 0.32, visibility: 1 };
    return p;
  }
  if (exercise === 'burpee') {
    const phase = (time / 900) % 1;
    if (phase < 0.35) {
      p[15] = { x: 0.4, y: 0.84, visibility: 1 };
      p[23] = { x: 0.48, y: 0.7, visibility: 1 };
      p[27] = { x: 0.5, y: 0.9, visibility: 1 };
    } else if (phase < 0.7) {
      p[15] = { x: 0.32, y: 0.54, visibility: 1 };
      p[23] = { x: 0.46, y: 0.54, visibility: 1 };
      p[27] = { x: 0.46, y: 0.9, visibility: 1 };
    } else {
      p[15] = { x: 0.32, y: 0.4, visibility: 1 };
      p[23] = { x: 0.46, y: 0.42, visibility: 1 };
      p[27] = { x: 0.46, y: 0.78, visibility: 1 };
    }
    return p;
  }
  if (exercise === 'boxing') {
    const left = Math.sin(time / 160) > 0;
    p[15] = { x: left ? 0.22 : 0.32, y: 0.42, visibility: 1 };
    p[16] = { x: left ? 0.68 : 0.78, y: 0.42, visibility: 1 };
    return p;
  }
  if (exercise === 'russian_twist') {
    const rot = Math.sin(time / 220) * 0.1;
    p[11] = { x: 0.44 + rot, y: 0.4, visibility: 1 };
    p[12] = { x: 0.56 + rot, y: 0.4, visibility: 1 };
    p[23] = { x: 0.46, y: 0.58, visibility: 1 };
    p[24] = { x: 0.54, y: 0.58, visibility: 1 };
    return p;
  }
  if (exercise === 'arm_circle') {
    const a = time / 180;
    p[15] = { x: 0.44 + Math.cos(a) * 0.16, y: 0.28 + Math.sin(a) * 0.16, visibility: 1 };
    p[16] = {
      x: 0.56 + Math.cos(a + Math.PI) * 0.16,
      y: 0.28 + Math.sin(a + Math.PI) * 0.16,
      visibility: 1,
    };
    return p;
  }
  if (exercise === 'jumping_squat') {
    const squat = wave(time, 700);
    p[23] = {
      x: 0.46 + squat * 0.1,
      y: 0.52 + squat * 0.16 - (squat < 0.15 ? 0.06 : 0),
      visibility: 1,
    };
    p[24] = { x: 0.54 + squat * 0.1, y: 0.52 + squat * 0.16, visibility: 1 };
    p[25] = { x: 0.46, y: 0.7, visibility: 1 };
    p[27] = { x: 0.46, y: 0.9, visibility: 1 };
    return p;
  }
  const squat = (1 - Math.cos(time / 350)) / 2;
  p[11] = { x: 0.44, y: 0.24, visibility: 1 };
  p[12] = { x: 0.56, y: 0.24, visibility: 1 };
  p[23] = { x: 0.44 + squat * 0.13, y: 0.5 + squat * 0.18, visibility: 1 };
  p[24] = { x: 0.56 + squat * 0.13, y: 0.5 + squat * 0.18, visibility: 1 };
  p[25] = { x: 0.44, y: 0.7, visibility: 1 };
  p[26] = { x: 0.56, y: 0.7, visibility: 1 };
  p[27] = { x: 0.44, y: 0.9, visibility: 1 };
  p[28] = { x: 0.56, y: 0.9, visibility: 1 };
  p[13] = { x: 0.35, y: 0.38, visibility: 1 };
  p[14] = { x: 0.65, y: 0.38, visibility: 1 };
  p[15] = { x: 0.3, y: 0.5, visibility: 1 };
  p[16] = { x: 0.7, y: 0.5, visibility: 1 };
  return p;
}
