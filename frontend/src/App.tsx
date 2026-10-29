import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Camera,
  Check,
  ClipboardList,
  Download,
  Flame,
  Leaf,
  LockKeyhole,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { EXERCISE_GROUPS, EXERCISE_IDS, EXERCISES, exerciseLabel, isExercise } from './catalog';
import { ExerciseEngine, simulatedPose } from './engine';
import {
  acceptReport,
  decideReport,
  getSessionState,
  isApiError,
  reportSafetyEvent,
  request,
} from './api';
import { ActivityTracker, type ActivityState } from './activity';
import { LandmarkRecorder, type ReplayClip } from './replay';
import { runtimeMode, strictOffline } from './runtime';
import { drawAvatar, drawRawPose, drawRetargetedOverlay, drawVideoFrame, syncCanvas } from './draw';
import { dailyRequirement, sessionEnergy, type ActivityLevel, type Sex } from './energy';
import { estimateFoods, searchFoods } from './foods';
import { defaultProfile, retargetPose } from './smpl';
import type { BodyModel } from './smpl';
import type { Exercise, Metrics, Point, Report, SessionState, SourceMode } from './types';
import type { ExplanationResponse } from './types';
const roleNames: Record<string, string> = {
  training_analyst: '训练分析',
  plan_adapter: '计划调整',
  safety_gate: '规则检查',
  reporter: '报告生成',
};
const emptyMetrics: Metrics = {
  reps: 0,
  phase: 'ready',
  quality: false,
  hint: '选择动作，开始一组训练。',
  angle: 180,
  events: 0,
  squatReps: [],
};
const SAFETY_STOP_NOTICE =
  '已记录不适：本次训练已立即停止计时与动作处理。取消勾选不会解除本组阻断；请结束本组查看阻断报告。本页不会自动开始新训练组。';
const SAFETY_SYNC_PENDING_NOTICE =
  '本地已阻断；服务端同步状态待确认（服务端可能尚未记录该事件）。恢复连接后可重试同步，重试沿用同一事件 ID。';
const SAFETY_SYNC_FAILED_NOTICE =
  '本地已阻断，但服务端同步失败（网络/服务异常，事件可能未记录）。本组仍不可继续；可重试同步同一事件。';
const SAFETY_EXPIRED_NOTICE =
  '服务端会话已过期：旧报告不能继续用于本组。请开始新的训练组（不会复用旧报告或旧锁存）。';
const SAFETY_STATE_UNKNOWN_NOTICE =
  '无法确认服务端安全状态：本组保持不可继续。请刷新页面或重试状态查询后再开始。';
const SAFETY_STATE_CHECKING_NOTICE =
  '正在核对服务端会话状态：核对完成前不能开始训练、提交决定或生成报告。';
const SAFETY_STORAGE_NOTICE =
  '浏览器无法持久化安全状态（会话 ID / 安全锁存）：本组保持不可开始或继续，刷新后也不会假定已恢复。请检查浏览器存储权限后刷新页面。';
const SAFETY_STORAGE_READ_NOTICE =
  '浏览器存储中的会话/安全状态无法可靠读取或已损坏：本组保持阻断。不会把它当作“没有活动会话”，也不会自动创建新会话；请修复浏览器存储或刷新后重新核对。';
const SAFETY_SESSION_MISSING_NOTICE =
  '本地保存的训练会话在服务端不存在（可能服务端重启或数据被清理）。本组无法恢复；不会复用旧会话 ID，也不会自动开始新组。';
const SAFETY_ANALYSIS_LOST_NOTICE =
  '上一次分析可能已在服务端提交，但本页没有收到报告。本组安全阻断仍然有效；不会重复使用相同 input_version 发送不同内容。';
// Session identity and the local safety latch are persisted separately from the
// user history so deleting history never deletes the active session or its latch.
export const ACTIVE_SESSION_KEY = 'localfit-active-session';
export const LOCAL_SAFETY_KEY = 'localfit-safety-latch';

type StoredSafety = {
  session_id: string;
  event_id: string;
  server_confirmed: boolean;
  safety_version: number | null;
};

type AnalysisPayload = Record<string, unknown>;
type AnalysisRecovery = {
  session_id: string;
  reason: 'lost' | 'pre-latch';
  serverInputVersion: number | null;
  reportRecoverable: boolean;
  nextInputVersion: number;
};
type RemoteDecision = {
  session_id: string;
  status: 'accepted' | 'rejected';
  decided_at: string | null;
  recoverable: boolean;
};
type PoseStatus = 'initializing' | 'worker' | 'main-thread' | 'failed' | 'retrying';

type StoredSession = {
  session_id: string;
  safety_latched?: boolean;
  event_id?: string;
};
type StoredRead<T> =
  | { state: 'missing' }
  | { state: 'ok'; value: T }
  | { state: 'invalid'; reason: string };
type BootStorage = {
  healthy: boolean;
  active: StoredRead<StoredSession>;
  safety: StoredRead<StoredSafety>;
  sessionId: string | null;
  safetyLatched: boolean;
  eventId: string | null;
  invalid: boolean;
  notice: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredSession(value: unknown): value is StoredSession {
  if (
    !isRecord(value) ||
    typeof value.session_id !== 'string' ||
    value.session_id.trim() === '' ||
    (value.safety_latched !== undefined && typeof value.safety_latched !== 'boolean') ||
    (value.event_id !== undefined && typeof value.event_id !== 'string')
  )
    return false;
  return (
    value.safety_latched !== true ||
    (typeof value.event_id === 'string' && value.event_id.trim() !== '')
  );
}

function isStoredSafety(value: unknown): value is StoredSafety {
  return (
    isRecord(value) &&
    typeof value.session_id === 'string' &&
    value.session_id.trim() !== '' &&
    typeof value.event_id === 'string' &&
    value.event_id.trim() !== '' &&
    typeof value.server_confirmed === 'boolean' &&
    (value.safety_version === null || typeof value.safety_version === 'number')
  );
}

function readStored<T>(
  key: string,
  validate: (value: unknown) => value is T,
): StoredRead<T> {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return { state: 'missing' };
    if (raw.trim() === '') return { state: 'invalid', reason: 'empty value' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: 'invalid', reason: 'invalid JSON' };
    }
    if (!validate(parsed)) return { state: 'invalid', reason: 'invalid shape' };
    return { state: 'ok', value: parsed };
  } catch (error) {
    return {
      state: 'invalid',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
/** Returns false when the write could not be guaranteed (private mode/quota). */
function writeStored(key: string, value: unknown): boolean {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function removeStored(key: string): boolean {
  try {
    sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
/** Detect unusable sessionStorage before trusting any recovery assumption. */
function probeSessionStorage(): boolean {
  const probe = 'localfit-storage-probe';
  try {
    sessionStorage.setItem(probe, '1');
    if (sessionStorage.getItem(probe) !== '1') return false;
    sessionStorage.removeItem(probe);
    return sessionStorage.getItem(probe) === null;
  } catch {
    return false;
  }
}
/** Read and validate the two recovery keys once, before the first paint. */
function inspectBootStorage(): BootStorage {
  const healthy = probeSessionStorage();
  const active = readStored(ACTIVE_SESSION_KEY, isStoredSession);
  const safety = readStored(LOCAL_SAFETY_KEY, isStoredSafety);
  const activeLatched = active.state === 'ok' && active.value.safety_latched === true;
  const safetyLatched = safety.state === 'ok';
  const inconsistentSession =
    active.state === 'ok' &&
    safety.state === 'ok' &&
    active.value.session_id !== safety.value.session_id;
  const inconsistentEvent =
    activeLatched &&
    safety.state === 'ok' &&
    active.value.event_id !== safety.value.event_id;
  const invalid =
    active.state === 'invalid' ||
    safety.state === 'invalid' ||
    inconsistentSession ||
    inconsistentEvent;
  const sessionId =
    active.state === 'ok'
      ? active.value.session_id
      : safety.state === 'ok'
        ? safety.value.session_id
        : null;
  const eventId =
    safety.state === 'ok'
      ? safety.value.event_id
      : activeLatched && active.state === 'ok'
        ? active.value.event_id ?? null
        : null;
  return {
    healthy,
    active,
    safety,
    sessionId,
    safetyLatched: activeLatched || safetyLatched,
    eventId,
    invalid,
    notice: invalid
      ? SAFETY_STORAGE_READ_NOTICE
      : !healthy
        ? SAFETY_STORAGE_NOTICE
        : SAFETY_STORAGE_NOTICE,
  };
}

export default function App() {
  const [bootStorage] = useState<BootStorage>(inspectBootStorage);
  const initialSafetyLatched =
    bootStorage.healthy && !bootStorage.invalid && bootStorage.safetyLatched;
  const initialSessionId =
    bootStorage.healthy && !bootStorage.invalid ? bootStorage.sessionId : null;
  const initialSafetyEventId =
    bootStorage.healthy && !bootStorage.invalid ? bootStorage.eventId : null;
  const browserLatchRecovered = runtimeMode === 'browser' && initialSafetyLatched;
  const [tab, setTab] = useState('training');
  const [exercise, setExercise] = useState<Exercise>('squat');
  const [showExperimental, setShowExperimental] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>('simulation');
  const [modelReady, setModelReady] = useState(false);
  const [poseStatus, setPoseStatus] = useState<PoseStatus>('initializing');
  const [poseRetryKey, setPoseRetryKey] = useState(0);
  const [running, setRunning] = useState(false);
  const [cameraInterrupted, setCameraInterrupted] = useState(false);
  const mountedRef = useRef(true);
  const sourceModeRef = useRef<SourceMode>('simulation');
  const cameraLifecycle = useRef(0);
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [elapsed, setElapsed] = useState(0);
  const [weight, setWeight] = useState(65);
  const [height, setHeight] = useState(170);
  const [age, setAge] = useState(22);
  const [sex, setSex] = useState<Sex>('unspecified');
  const [activity, setActivity] = useState<ActivityLevel>('light');
  const [muscleUpper, setMuscleUpper] = useState(0.45);
  const [muscleCore, setMuscleCore] = useState(0.4);
  const [muscleLower, setMuscleLower] = useState(0.45);
  const [bodyModel, setBodyModel] = useState<BodyModel>('smpl');
  const [showRaw, setShowRaw] = useState(true);
  const [target, setTarget] = useState(12);
  const [threshold, setThreshold] = useState(105);
  const [fatigue, setFatigue] = useState(4);
  const [discomfort, setDiscomfort] = useState(initialSafetyLatched);
  const [discomfortBlocked, setDiscomfortBlocked] = useState(initialSafetyLatched);
  const [persist, setPersist] = useState(false);
  const [captureLandmarks, setCaptureLandmarks] = useState(false);
  const recorder = useRef(new LandmarkRecorder());
  const [report, setReport] = useState<Report | null>(null);
  const [history, setHistory] = useState<Report[]>([]);
  const [historyStatus, setHistoryStatus] = useState<{
    kind: 'info' | 'error';
    text: string;
  } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [apiReady, setApiReady] = useState(false);
  const [exerciseQuery, setExerciseQuery] = useState('');
  const [foodQuery, setFoodQuery] = useState('');
  const [grams, setGrams] = useState(150);
  const [customKcal, setCustomKcal] = useState('');
  const [showFoodSuggest, setShowFoodSuggest] = useState(false);
  const [foodBusy, setFoodBusy] = useState(false);
  const [foodError, setFoodError] = useState('');
  const [foodResult, setFoodResult] = useState<{
    total_kcal: number;
    note: string;
    items?: { name: string; grams: number; total_kcal: number; matched: boolean }[];
  } | null>(null);
  const [meal, setMeal] = useState<{ name: string; grams: number; total_kcal: number }[]>([]);
  const [mealConfirmed, setMealConfirmed] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [videoName, setVideoName] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const avatar = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const cameraTrackCleanup = useRef<(() => void) | null>(null);
  const cameraRequest = useRef<Promise<MediaStream> | null>(null);
  const videoUrl = useRef('');
  const worker = useRef<Worker | null>(null);
  const poseMain = useRef<{
    detectForVideo: (
      image: HTMLVideoElement | ImageBitmap,
      timestamp: number,
    ) => {
      landmarks: Point[][];
      worldLandmarks: Point[][];
    };
    close?: () => void;
  } | null>(null);
  const poseRuntimeFailedRef = useRef(false);
  const ingestPose = useRef<
    (data: {
      points: Point[];
      worldPoints?: Point[];
      activeElapsedMs: number;
      aspectRatio?: number;
      generation: number;
    }) => void
  >(() => {});
  const points = useRef<Point[]>([]);
  const worldPoints = useRef<Point[]>([]);
  const engine = useRef(new ExerciseEngine('squat'));
  const activityTracker = useRef(new ActivityTracker());
  const generation = useRef(0);
  const live = useRef({
    running: false,
    source: 'simulation' as SourceMode,
    ready: false,
    elapsed: 0,
    observable: 0,
    work: 0,
    rest: 0,
    activityState: 'unknown' as ActivityState,
    quality: false,
    lastPose: 0,
    frameBusy: false,
  });
  const metricRef = useRef(emptyMetrics);
  const profileRef = useRef(defaultProfile());
  const showRawRef = useRef(true);
  const discomfortBlockedRef = useRef(initialSafetyLatched);
  const finishInFlightRef = useRef(false);
  const finishAbortRef = useRef<AbortController | null>(null);
  const decisionAbortRef = useRef<AbortController | null>(null);
  // FE-BE-01: a stable session id exists before any real action processing starts
  // and is shared by the safety event, analysis, explanation and decisions.
  const sessionIdRef = useRef<string | null>(initialSafetyLatched ? initialSessionId : null);
  const safetyEventIdRef = useRef<string | null>(initialSafetyLatched ? initialSafetyEventId : null);
  const stateUnknownRef = useRef(false);
  const [safetySync, setSafetySync] = useState<
    'idle' | 'syncing' | 'pending' | 'confirmed' | 'expired'
  >('idle');
  const [safetyVersion, setSafetyVersion] = useState<number | null>(null);
  const [stateUnknown, setStateUnknown] = useState(false);
  // FE-BE-01-R1: fail-closed gates.
  // - sessionChecking: a stored session exists and GET /state has not answered yet.
  // - storageFault: sessionStorage cannot reliably read/persist the session id / latch.
  // - sessionUninitialized: the backend answered 404 for the stored session id.
  const [sessionChecking, setSessionChecking] = useState<boolean>(
    () =>
      runtimeMode === 'backend' &&
      bootStorage.healthy &&
      !bootStorage.invalid &&
      Boolean(bootStorage.sessionId),
  );
  const [storageFault, setStorageFault] = useState<boolean>(
    () => !bootStorage.healthy || bootStorage.invalid,
  );
  const [storageFaultNotice, setStorageFaultNotice] = useState(bootStorage.notice);
  const [sessionUninitialized, setSessionUninitialized] = useState(false);
  const [analysisRecovery, setAnalysisRecovery] = useState<AnalysisRecovery | null>(null);
  const [remoteDecision, setRemoteDecision] = useState<RemoteDecision | null>(null);
  const sessionCheckingRef = useRef(sessionChecking);
  const storageFaultRef = useRef(storageFault);
  const uninitializedRef = useRef(false);
  const inputVersionRef = useRef(1);
  const lastAnalyzeRef = useRef<{
    sessionId: string;
    inputVersion: number;
    payload: AnalysisPayload;
  } | null>(null);
  const reportRef = useRef<Report | null>(null);
  const explanationAbortRef = useRef<AbortController | null>(null);
  const explanationTokenRef = useRef(0);

  useEffect(() => {
    request('/health')
      .then(() => setApiReady(true))
      .catch(() => setApiReady(false));
  }, []);
  useEffect(() => {
    reportRef.current = report;
  }, [report]);
  // Restore the active group and safety latch on same-tab reload in both runtimes.
  useEffect(() => {
    const boot = bootStorage;
    if (runtimeMode === 'browser') {
      if (!boot.healthy || boot.invalid) {
        storageFaultRef.current = true;
        setStorageFault(true);
        setStorageFaultNotice(boot.notice);
        setError(boot.notice);
        sessionCheckingRef.current = false;
        setSessionChecking(false);
        return;
      }
      if (boot.safetyLatched && boot.sessionId && boot.eventId) {
        sessionIdRef.current = boot.sessionId;
        safetyEventIdRef.current = boot.eventId;
        discomfortBlockedRef.current = true;
        setDiscomfort(true);
        setDiscomfortBlocked(true);
        if (
          !writeStored(ACTIVE_SESSION_KEY, {
            session_id: boot.sessionId,
            safety_latched: true,
            event_id: boot.eventId,
          })
        )
          noteStorageFault();
        if (
          boot.safety.state !== 'ok' &&
          !writeStored(LOCAL_SAFETY_KEY, {
            session_id: boot.sessionId,
            event_id: boot.eventId,
            server_confirmed: false,
            safety_version: null,
          } satisfies StoredSafety)
        )
          noteStorageFault();
      } else {
        // A non-blocked group has no recoverable live metrics after a page reload.
        // Retire its stale identity so the next start is a new group, not a replay.
        sessionIdRef.current = null;
        safetyEventIdRef.current = null;
        if (boot.active.state === 'ok' && !removeStored(ACTIVE_SESSION_KEY)) noteStorageFault();
      }
      sessionCheckingRef.current = false;
      setSessionChecking(false);
      return;
    }
    if (runtimeMode !== 'backend') {
      sessionCheckingRef.current = false;
      setSessionChecking(false);
      return;
    }
    if (!boot.healthy || boot.invalid) {
      // An unreadable or corrupt active-session/latch key is not the same as an
      // empty store. Fail closed: never create a new session or query a guessed
      // id from data we could not validate.
      storageFaultRef.current = true;
      setStorageFault(true);
      setStorageFaultNotice(boot.notice);
      setError(boot.notice);
      sessionCheckingRef.current = false;
      setSessionChecking(false);
      return;
    }
    const active = boot.active;
    const storedSafety = boot.safety;
    const sessionId = boot.sessionId;
    if (!sessionId) {
      sessionCheckingRef.current = false;
      setSessionChecking(false);
      return;
    }
    sessionIdRef.current = sessionId;
    if (active.state !== 'ok') {
      // The latch survived but the active-session key did not. Re-persist the
      // identity best-effort and keep the block regardless of the outcome.
      if (!writeStored(ACTIVE_SESSION_KEY, { session_id: sessionId })) noteStorageFault();
    }
    if (
      storedSafety.state === 'ok' &&
      storedSafety.value.session_id === sessionId &&
      storedSafety.value.event_id
    ) {
      safetyEventIdRef.current = storedSafety.value.event_id;
      if (storedSafety.value.safety_version != null)
        setSafetyVersionValue(storedSafety.value.safety_version);
      discomfortBlockedRef.current = true;
      setDiscomfort(true);
      setDiscomfortBlocked(true);
      setSafetySyncState(storedSafety.value.server_confirmed ? 'confirmed' : 'pending');
    }
    sessionCheckingRef.current = true;
    setSessionChecking(true);
    void refreshSessionState(sessionId);
  }, []);
  useEffect(() => {
    live.current.running = running;
  }, [running]);
  useEffect(() => {
    profileRef.current = defaultProfile({
      heightCm: height,
      weightKg: weight,
      muscleUpper,
      muscleCore,
      muscleLower,
      model: bodyModel,
    });
  }, [height, weight, muscleUpper, muscleCore, muscleLower, bodyModel]);
  useEffect(() => {
    showRawRef.current = showRaw;
  }, [showRaw]);
  useEffect(() => {
    // Changing exercise/threshold/source discards the visible report. Retire the
    // old session so a later analysis never reuses its input_version=1 with
    // different content.
    if (
      runtimeMode === 'backend' &&
      sessionIdRef.current &&
      reportRef.current &&
      !discomfortBlockedRef.current
    ) {
      retireSessionStorage();
    }
    engine.current = new ExerciseEngine(exercise, threshold);
    recorder.current = new LandmarkRecorder();
    generation.current++;
    live.current.elapsed = 0;
    live.current.observable = 0;
    live.current.work = 0;
    live.current.rest = 0;
    live.current.activityState = 'unknown';
    activityTracker.current = new ActivityTracker();
    live.current.quality = false;
    metricRef.current = emptyMetrics;
    setMetrics(emptyMetrics);
    setElapsed(0);
    setReport(null);
    setExplanation('');
  }, [exercise, threshold, sourceMode]);

  ingestPose.current = (data) => {
    live.current.frameBusy = false;
    if (data.generation !== generation.current) return;
    points.current = data.points;
    worldPoints.current = data.worldPoints ?? [];
    if (live.current.running && live.current.source !== 'simulation') {
      if (captureLandmarks)
        recorder.current.add(data.points, data.activeElapsedMs, data.aspectRatio ?? 1);
      const result = engine.current.update(data.points, data.activeElapsedMs, data.aspectRatio);
      metricRef.current = result;
      live.current.quality = result.quality;
      live.current.activityState = activityTracker.current.update(
        data.points,
        data.activeElapsedMs,
        result.quality,
        data.aspectRatio,
      );
      live.current.lastPose = performance.now();
      setMetrics(result);
    }
  };

  function handlePoseRuntimeFailure(message: string) {
    if (poseRuntimeFailedRef.current) return;
    poseRuntimeFailedRef.current = true;
    live.current.running = false;
    live.current.frameBusy = false;
    live.current.ready = false;
    generation.current += 1;
    setRunning(false);
    setModelReady(false);
    setPoseStatus('failed');
    worker.current?.terminate();
    worker.current = null;
    poseMain.current?.close?.();
    poseMain.current = null;
    setError('姿态模型运行失败：' + message + ' 本组计时已停止；请点击“重试模型加载”后重新开始。');
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cameraLifecycle.current += 1;
      releaseCamera();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let fallbackStarted = false;
    let poseWorker: Worker | null = null;
    const assetBase = new URL(import.meta.env.BASE_URL, location.href).href.replace(/\/$/, '');
    const origin = assetBase || location.origin;
    poseRuntimeFailedRef.current = false;
    generation.current += 1;
    setModelReady(false);
    live.current.ready = false;
    setPoseStatus(poseRetryKey > 0 ? 'retrying' : 'initializing');

    const markReady = (status: 'worker' | 'main-thread') => {
      if (cancelled || poseRuntimeFailedRef.current) return;
      live.current.ready = true;
      setModelReady(true);
      setPoseStatus(status);
      setError((prev) => (prev.startsWith('姿态模型') ? '' : prev));
    };
    const startMainThread = async () => {
      try {
        const { createPoseLandmarker } = await import('./pose');
        const model = await createPoseLandmarker(origin, () => {
          if (!cancelled) setError('');
        });
        if (cancelled || poseRuntimeFailedRef.current) {
          model.close();
          return;
        }
        poseMain.current = model;
        markReady('main-thread');
      } catch (error) {
        if (cancelled || poseRuntimeFailedRef.current) return;
        live.current.frameBusy = false;
        live.current.ready = false;
        setModelReady(false);
        setPoseStatus('failed');
        setError('姿态模型未就绪：' + String(error));
      }
    };
    const abandonWorker = () => {
      poseWorker?.terminate();
      poseWorker = null;
      worker.current = null;
    };
    const startMainThreadOnce = () => {
      if (fallbackStarted || cancelled || live.current.ready) return;
      fallbackStarted = true;
      abandonWorker();
      setPoseStatus('retrying');
      setError('姿态模型改在页面内加载…');
      void startMainThread();
    };

    try {
      // Classic IIFE worker: MediaPipe's WASM loader calls importScripts, which
      // does not exist in `{ type: 'module' }` workers.
      poseWorker = new Worker(new URL('./pose.worker.ts', import.meta.url));
      worker.current = poseWorker;
      poseWorker.onmessage = (event: MessageEvent) => {
        if (cancelled || poseRuntimeFailedRef.current) return;
        if (event.data.type === 'progress') setError('');
        if (event.data.type === 'ready') markReady('worker');
        if (event.data.type === 'error') {
          live.current.frameBusy = false;
          if (!live.current.ready) {
            startMainThreadOnce();
            return;
          }
          handlePoseRuntimeFailure('Worker 运行中断 ' + String(event.data.message || ''));
          return;
        }
        if (event.data.type === 'pose') ingestPose.current(event.data);
      };
      poseWorker.onerror = () => {
        if (cancelled || poseRuntimeFailedRef.current) return;
        if (live.current.ready) {
          handlePoseRuntimeFailure('Worker 运行错误');
          return;
        }
        if (fallbackStarted) return;
        live.current.ready = false;
        setModelReady(false);
        startMainThreadOnce();
      };
      poseWorker.postMessage({ type: 'init', origin, strictOffline });
    } catch {
      startMainThreadOnce();
    }

    return () => {
      cancelled = true;
      poseWorker?.terminate();
      worker.current = null;
      poseMain.current?.close?.();
      poseMain.current = null;
    };
  }, [poseRetryKey]);

  function retryPose() {
    if (poseStatus === 'retrying') return;
    setPoseStatus('retrying');
    setModelReady(false);
    live.current.ready = false;
    setError('');
    setPoseRetryKey((key) => key + 1);
  }

  function acquireCameraStream(): Promise<MediaStream> {
    if (cameraRequest.current) return cameraRequest.current;
    const request = navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 1280, height: 720 },
      audio: false,
    });
    cameraRequest.current = request;
    void request.then(
      () => {
        if (cameraRequest.current === request) cameraRequest.current = null;
      },
      () => {
        if (cameraRequest.current === request) cameraRequest.current = null;
      },
    );
    return request;
  }

  function releaseCameraIfCurrent(media: MediaStream) {
    if (stream.current === media) releaseCamera();
  }

  function cameraOperationActive(token: number): boolean {
    return (
      mountedRef.current &&
      sourceModeRef.current === 'camera' &&
      !discomfortBlockedRef.current &&
      cameraLifecycle.current === token
    );
  }

  function stopCameraStream(media: MediaStream) {
    for (const track of media.getTracks()) {
      try {
        track.stop();
      } catch {
        // A track may already be stopped by the browser.
      }
    }
  }

  function discardStaleCameraStream(media: MediaStream, token: number) {
    // A stale request must never tear down a stream already installed by a
    // newer operation. If it is that same stream, leave it to its owner unless
    // this token is still current and the operation became invalid due to a
    // safety/source/mount transition.
    if (stream.current === media) {
      if (cameraLifecycle.current === token) releaseCameraIfCurrent(media);
      return;
    }
    if (
      !mountedRef.current ||
      sourceModeRef.current !== 'camera' ||
      discomfortBlockedRef.current
    ) {
      stopCameraStream(media);
      return;
    }
    // If a newer stream has been installed, this old stream is no longer the
    // active camera and can be stopped. If no stream exists yet, a newer camera
    // operation may still be consuming the same request; leave it to that owner.
    if (stream.current && stream.current !== media) stopCameraStream(media);
  }

  function detachCameraTrackListeners() {
    cameraTrackCleanup.current?.();
    cameraTrackCleanup.current = null;
  }

  function attachCameraTrackListeners(media: MediaStream) {
    detachCameraTrackListeners();
    if (typeof media.getVideoTracks !== 'function') return;
    const tracks = media.getVideoTracks();
    const onEnded = () => {
      // A listener removed before track.stop() must never turn a normal
      // source switch/reset/unmount into a camera-interruption error.
      if (cameraTrackCleanup.current === null) return;
      handleCameraInterrupted();
    };
    for (const track of tracks) {
      if (typeof track.addEventListener === 'function') track.addEventListener('ended', onEnded);
    }
    cameraTrackCleanup.current = () => {
      for (const track of tracks) {
        if (typeof track.removeEventListener === 'function')
          track.removeEventListener('ended', onEnded);
      }
    };
  }

  function handleCameraInterrupted() {
    if (cameraTrackCleanup.current === null || discomfortBlockedRef.current) return;
    live.current.running = false;
    live.current.frameBusy = false;
    generation.current++;
    setRunning(false);
    detachCameraTrackListeners();
    releaseCamera();
    setCameraInterrupted(true);
    setError('摄像头连接已中断。请重新连接摄像头并重置本组后再开始；本次不会把无画面时间计入训练。');
  }

  async function reconnectCamera() {
    if (sourceModeRef.current !== 'camera') {
      chooseSource('camera');
      return;
    }
    if (!mountedRef.current) return;
    const requestToken = ++cameraLifecycle.current;
    let media: MediaStream | null = null;
    setError('');
    try {
      media = await acquireCameraStream();
      if (!cameraOperationActive(requestToken)) {
        discardStaleCameraStream(media, requestToken);
        return;
      }
      if (stream.current && stream.current !== media) releaseCamera();
      stream.current = media;
      attachCameraTrackListeners(media);
      if (video.current) {
        video.current.srcObject = media;
        try {
          await video.current.play();
        } catch {
          if (cameraOperationActive(requestToken)) {
            releaseCameraIfCurrent(media);
            setCameraInterrupted(true);
            setError('无法播放摄像头画面；本次流已清理，请重新连接摄像头。');
          } else {
            discardStaleCameraStream(media, requestToken);
          }
          return;
        }
        if (!cameraOperationActive(requestToken)) {
          discardStaleCameraStream(media, requestToken);
          return;
        }
      }
      // Only clear the interrupted state after the explicit reset succeeds.
      // reset() may be refused by a safety/storage/session gate; preserve that
      // gate's exact error instead of overwriting it with a false success.
      if (!reset()) {
        releaseCameraIfCurrent(media);
        if (cameraOperationActive(requestToken)) setCameraInterrupted(true);
        return;
      }
      if (!cameraOperationActive(requestToken)) {
        discardStaleCameraStream(media, requestToken);
        return;
      }
      setCameraInterrupted(false);
      setError('摄像头已重新连接；本组计数已重置，请重新开始。');
    } catch (e) {
      if (media) {
        if (stream.current === media) releaseCameraIfCurrent(media);
        else discardStaleCameraStream(media, requestToken);
      }
      if (cameraOperationActive(requestToken)) {
        setCameraInterrupted(true);
        setError('无法重新连接摄像头：' + String(e));
      }
    }
  }

  function releaseCamera() {
    detachCameraTrackListeners();
    const media = stream.current;
    stream.current = null;
    if (media) {
      for (const track of media.getTracks()) {
        try {
          track.stop();
        } catch {
          // A track may already be stopped by the browser.
        }
      }
    }
    if (video.current) {
      try {
        video.current.pause();
      } catch {
        // JSDOM and some browsers can throw if the element is not ready.
      }
      if (video.current.srcObject) {
        try {
          video.current.srcObject = null;
        } catch {
          // The element can already be detached during unmount.
        }
      }
    }
  }

  // --- FE-BE-01 session / safety lifecycle --------------------------------
  function setSafetySyncState(next: 'idle' | 'syncing' | 'pending' | 'confirmed' | 'expired') {
    setSafetySync(next);
  }
  function setSafetyVersionValue(next: number | null) {
    setSafetyVersion(next);
  }
  function setChecking(next: boolean) {
    sessionCheckingRef.current = next;
    setSessionChecking(next);
  }
  function setUninitialized(next: boolean) {
    uninitializedRef.current = next;
    setSessionUninitialized(next);
  }
  function noteStorageFault(notice = SAFETY_STORAGE_NOTICE) {
    storageFaultRef.current = true;
    setStorageFault(true);
    setStorageFaultNotice(notice);
    setError(notice);
  }
  function clearRecovery() {
    setAnalysisRecovery(null);
  }
  function beginSession(): boolean {
    // Fail-closed: without guaranteed persistence the session id/latch could not
    // be restored after a refresh, so a new group must not start.
    if (storageFaultRef.current) {
      setError(storageFaultNotice);
      return false;
    }
    const id = crypto.randomUUID();
    if (!removeStored(LOCAL_SAFETY_KEY) || !writeStored(ACTIVE_SESSION_KEY, { session_id: id })) {
      sessionIdRef.current = null;
      noteStorageFault();
      return false;
    }
    sessionIdRef.current = id;
    safetyEventIdRef.current = null;
    inputVersionRef.current = 1;
    lastAnalyzeRef.current = null;
    clearRecovery();
    setUninitialized(false);
    setSafetySyncState('idle');
    setSafetyVersionValue(null);
    stateUnknownRef.current = false;
    setStateUnknown(false);
    return true;
  }
  function ensureSession(): string | null {
    if (!sessionIdRef.current && !beginSession()) return null;
    return sessionIdRef.current;
  }
  function retireSessionStorage() {
    const ok = removeStored(ACTIVE_SESSION_KEY) && removeStored(LOCAL_SAFETY_KEY);
    sessionIdRef.current = null;
    safetyEventIdRef.current = null;
    inputVersionRef.current = 1;
    lastAnalyzeRef.current = null;
    setSafetySyncState('idle');
    setSafetyVersionValue(null);
    setUninitialized(false);
    setAnalysisRecovery(null);
    if (!ok) noteStorageFault();
  }
  function completeSession() {
    retireSessionStorage();
    setRemoteDecision(null);
  }
  function expireCurrentSession(targetSessionId: string) {
    enterBlockedState();
    setSafetySyncState('expired');
    removeStored(LOCAL_SAFETY_KEY);
    removeStored(ACTIVE_SESSION_KEY);
    sessionIdRef.current = null;
    safetyEventIdRef.current = null;
    inputVersionRef.current = 1;
    lastAnalyzeRef.current = null;
    setUninitialized(false);
    setAnalysisRecovery(null);
    setRemoteDecision(null);
    setReport(null);
    setExplanation('');
    setError(SAFETY_EXPIRED_NOTICE);
    void targetSessionId;
  }
  function enterBlockedState() {
    discomfortBlockedRef.current = true;
    setDiscomfort(true);
    setDiscomfortBlocked(true);
    live.current.running = false;
    live.current.frameBusy = false;
    generation.current++;
    setRunning(false);
    releaseCamera();
    finishAbortRef.current?.abort();
    finishAbortRef.current = null;
    decisionAbortRef.current?.abort();
    decisionAbortRef.current = null;
    // A late explanation response must never be shown after the latch.
    explanationTokenRef.current++;
    explanationAbortRef.current?.abort();
    explanationAbortRef.current = null;
  }
  function adoptSessionState(targetSessionId: string, state: SessionState) {
    setSafetyVersionValue(state.safety_version);
    if (state.input_version != null) inputVersionRef.current = state.input_version;
    if (sessionIdRef.current === targetSessionId) {
      setReport((prev) => {
        if (!prev || prev.session_id !== targetSessionId) return prev;
        const next: Report = {
          ...prev,
          safety_latched: state.safety_latched,
          safety_version: state.safety_version,
        };
        if (state.input_version != null) next.input_version = state.input_version;
        if (state.proposal_status) {
          next.proposal = {
            ...prev.proposal,
            proposal_id: state.proposal_id ?? prev.proposal.proposal_id,
            status: state.proposal_status,
            blocked: state.proposal_status === 'blocked' ? true : prev.proposal.blocked,
            decided_at: state.decided_at ?? prev.proposal.decided_at ?? null,
          };
        }
        return next;
      });
    }
    if (state.safety_latched) {
      if (state.proposal_status === 'accepted' || state.proposal_status === 'rejected') {
        setRemoteDecision({
          session_id: targetSessionId,
          status: state.proposal_status,
          decided_at: state.decided_at,
          recoverable: state.report_recoverable,
        });
      }
      enterBlockedState();
      setSafetySyncState('confirmed');
      const eventId = safetyEventIdRef.current ?? 'server-latched';
      if (
        !writeStored(LOCAL_SAFETY_KEY, {
          session_id: targetSessionId,
          event_id: eventId,
          server_confirmed: true,
          safety_version: state.safety_version,
        } satisfies StoredSafety)
      )
        noteStorageFault();
      if (state.input_version != null && !reportRef.current && !state.report_recoverable) {
        setAnalysisRecovery({
          session_id: targetSessionId,
          reason: 'lost',
          serverInputVersion: state.input_version,
          reportRecoverable: false,
          nextInputVersion: state.input_version + 1,
        });
      }
      return;
    }
    if (state.proposal_status === 'accepted' || state.proposal_status === 'rejected') {
      // A committed decision is a fact; never show it as pending again and never
      // allow an opposite decision to overwrite it.
      setRemoteDecision({
        session_id: targetSessionId,
        status: state.proposal_status,
        decided_at: state.decided_at,
        recoverable: state.report_recoverable,
      });
      retireSessionStorage();
      return;
    }
    if (state.input_version != null && !reportRef.current && !state.report_recoverable) {
      // Analysis committed but the client has no report: keep the group blocked
      // for new analyses on that version; a later analysis must use version+1.
      setAnalysisRecovery({
        session_id: targetSessionId,
        reason: 'lost',
        serverInputVersion: state.input_version,
        reportRecoverable: false,
        nextInputVersion: state.input_version + 1,
      });
      setError(
        SAFETY_ANALYSIS_LOST_NOTICE +
          ` 服务端 input_version=${state.input_version}，报告不可恢复；下次分析将使用 input_version=${state.input_version + 1}。`,
      );
    }
  }
  async function refreshSessionState(
    targetSessionId: string,
  ): Promise<'clear' | 'latched' | 'expired' | 'uninitialized' | 'unknown' | 'decided'> {
    if (runtimeMode !== 'backend') return 'clear';
    setChecking(true);
    try {
      const state = await getSessionState(targetSessionId);
      stateUnknownRef.current = false;
      setStateUnknown(false);
      setUninitialized(false);
      if (state.status === 'expired') {
        expireCurrentSession(targetSessionId);
        return 'expired';
      }
      adoptSessionState(targetSessionId, state);
      if (state.safety_latched) return 'latched';
      if (state.proposal_status === 'accepted' || state.proposal_status === 'rejected')
        return 'decided';
      return 'clear';
    } catch (e) {
      if (isApiError(e) && e.status === 404) {
        // Known session id, unknown server session: fail-closed, never silently
        // reuse the id. The user must explicitly discard the unrecoverable group.
        stateUnknownRef.current = false;
        setStateUnknown(false);
        setUninitialized(true);
        setError(SAFETY_SESSION_MISSING_NOTICE);
        return 'uninitialized';
      }
      stateUnknownRef.current = true;
      setStateUnknown(true);
      setError(
        isApiError(e) && e.status === 410 ? SAFETY_EXPIRED_NOTICE : SAFETY_STATE_UNKNOWN_NOTICE,
      );
      return 'unknown';
    } finally {
      setChecking(false);
    }
  }
  async function syncSafetyEvent(eventId: string) {
    if (runtimeMode !== 'backend') return;
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    setSafetySyncState('syncing');
    try {
      const receipt = await reportSafetyEvent(sessionId, eventId);
      setSafetyVersionValue(receipt.safety_version);
      setSafetySyncState('confirmed');
      if (
        !writeStored(LOCAL_SAFETY_KEY, {
          session_id: sessionId,
          event_id: eventId,
          server_confirmed: true,
          safety_version: receipt.safety_version,
        } satisfies StoredSafety)
      )
        noteStorageFault();
      // A first analysis may have been committed while its response was lost;
      // reconcile against the authoritative input_version without guessing.
      void reconcileLostAnalysis(sessionId);
    } catch (e) {
      if (isApiError(e) && e.status === 410) {
        expireCurrentSession(sessionId);
        return;
      }
      setSafetySyncState('pending');
      setError(
        isApiError(e) && e.status === 503 ? SAFETY_SYNC_PENDING_NOTICE : SAFETY_SYNC_FAILED_NOTICE,
      );
      if (
        !writeStored(LOCAL_SAFETY_KEY, {
          session_id: sessionId,
          event_id: eventId,
          server_confirmed: false,
          safety_version: safetyVersion,
        } satisfies StoredSafety)
      )
        noteStorageFault();
    }
  }
  function retrySafetySync() {
    if (safetyEventIdRef.current) void syncSafetyEvent(safetyEventIdRef.current);
  }
  function startNewSessionAfterExpiry() {
    discomfortBlockedRef.current = false;
    setDiscomfort(false);
    setDiscomfortBlocked(false);
    setUninitialized(false);
    setRemoteDecision(null);
    setReport(null);
    setExplanation('');
    setError('');
    if (!beginSession()) setError(storageFaultNotice);
  }
  async function reconcileLostAnalysis(targetSessionId: string) {
    if (runtimeMode !== 'backend') return;
    if (sessionIdRef.current !== targetSessionId) return;
    try {
      const state = await getSessionState(targetSessionId);
      if (state.status === 'expired') return;
      stateUnknownRef.current = false;
      setStateUnknown(false);
      adoptSessionState(targetSessionId, state);
      if (state.input_version != null && !reportRef.current) {
        const recovery: AnalysisRecovery = {
          session_id: targetSessionId,
          reason: 'lost',
          serverInputVersion: state.input_version,
          reportRecoverable: state.report_recoverable,
          nextInputVersion: state.input_version + 1,
        };
        setAnalysisRecovery(recovery);
        setError(
          SAFETY_ANALYSIS_LOST_NOTICE +
            ` 服务端 input_version=${state.input_version}；可点击「核对并恢复本组报告」。`,
        );
      }
    } catch {
      // Keep the local latch; stateUnknown/checking gates remain fail-closed.
    }
  }
  async function handleDecisionError(error: unknown, target: Report) {
    if (isApiError(error)) {
      if (error.status === 409) {
        const outcome = await refreshSessionState(target.session_id);
        if (outcome === 'decided') {
          setError('决定已在服务端提交（409）：已刷新权威状态，不能用相反决定覆盖已提交的事实。');
        } else if (outcome === 'latched') {
          setError('安全状态已变化（409）：本组已锁存，不能继续或提交决定。');
        } else if (outcome === 'clear') {
          setError(
            '提案或安全状态已变化（409）：已刷新权威状态，请查看最新结果，不要自动重复不同决定。',
          );
        }
        return;
      }
      if (error.status === 410) {
        setError(SAFETY_EXPIRED_NOTICE);
        setReport(null);
        void refreshSessionState(target.session_id);
        return;
      }
      if (error.status === 503) {
        const outcome = await refreshSessionState(target.session_id);
        if (outcome === 'decided') {
          setError('服务端已提交该决定（503 后经核对确认）：已刷新，不能用相反决定覆盖。');
        } else if (outcome !== 'unknown' && outcome !== 'uninitialized') {
          setError(
            '服务端未能确认该操作（503）：操作可能已经提交。已刷新状态核对；不能直接重复相反决定。',
          );
        }
        return;
      }
    }
    if (!discomfortBlockedRef.current) setError(String(error));
  }
  function discardUninitializedSession() {
    if (storageFaultRef.current) {
      setError(storageFaultNotice);
      return;
    }
    // Explicit user confirmation: the old local session/latch cannot be mapped to
    // server state, so drop it and create a genuinely new session id.
    const cleared = removeStored(ACTIVE_SESSION_KEY) && removeStored(LOCAL_SAFETY_KEY);
    sessionIdRef.current = null;
    safetyEventIdRef.current = null;
    inputVersionRef.current = 1;
    lastAnalyzeRef.current = null;
    clearRecovery();
    setRemoteDecision(null);
    setUninitialized(false);
    discomfortBlockedRef.current = false;
    setDiscomfort(false);
    setDiscomfortBlocked(false);
    setSafetySyncState('idle');
    setSafetyVersionValue(null);
    stateUnknownRef.current = false;
    setStateUnknown(false);
    setReport(null);
    setExplanation('');
    if (!cleared) {
      noteStorageFault();
      return;
    }
    if (beginSession()) {
      setError('已丢弃无法恢复的旧会话；新的训练组使用新的会话 ID。');
    }
  }
  function buildAnalysisPayload(version: number): AnalysisPayload {
    return {
      session_id: sessionIdRef.current,
      input_version: version,
      exercise,
      source: sourceMode,
      reps: metricRef.current.reps,
      active_seconds: live.current.elapsed,
      observable_seconds: Math.min(live.current.observable, live.current.elapsed),
      work_seconds: live.current.work,
      rest_seconds: live.current.rest,
      form_events: metricRef.current.events,
      rep_details: exercise === 'squat' ? metricRef.current.squatReps : [],
      fatigue,
      discomfort: discomfortBlockedRef.current,
      target_reps: target,
      persist,
      profile: {
        weight_kg: weight,
        height_cm: height,
        age_years: age,
        sex,
        activity,
        muscle_upper: muscleUpper,
        muscle_core: muscleCore,
        muscle_lower: muscleLower,
        body_model: bodyModel,
        experience: 'beginner',
        goal: 'habit',
      },
    };
  }
  function applyAnalyzeResult(result: Report, payload: AnalysisPayload) {
    const sentVersion = Number(payload.input_version);
    lastAnalyzeRef.current = {
      sessionId: result.session_id,
      inputVersion: sentVersion,
      payload,
    };
    inputVersionRef.current = result.input_version ?? sentVersion;
    setAnalysisRecovery(null);
    if (result.safety_version != null) setSafetyVersionValue(result.safety_version);
    setReport(result);
    setTab('report');
    if (result.safety_latched || result.proposal.blocked) {
      if (result.safety_latched) setSafetySyncState('confirmed');
      enterBlockedState();
    }
    setError('');
  }
  async function prepareAnalysis(): Promise<{ version: number; payload: AnalysisPayload } | null> {
    const sessionId = ensureSession();
    if (!sessionId) return null;
    if (runtimeMode !== 'backend') {
      return { version: 1, payload: buildAnalysisPayload(1) };
    }
    let state: SessionState | null = null;
    try {
      state = await getSessionState(sessionId);
    } catch (e) {
      if (!(isApiError(e) && e.status === 404)) {
        if (isApiError(e) && e.status === 410) {
          setError(SAFETY_EXPIRED_NOTICE);
        } else {
          stateUnknownRef.current = true;
          setStateUnknown(true);
          setError(SAFETY_STATE_UNKNOWN_NOTICE + ' 本次分析未提交。');
        }
        return null;
      }
    }
    if (state) {
      if (state.status === 'expired') {
        expireCurrentSession(sessionId);
        return null;
      }
      adoptSessionState(sessionId, state);
      if (state.proposal_status === 'accepted' || state.proposal_status === 'rejected') {
        setError('本组决定已在服务端提交，不能再次分析或重复决定；请开始新的训练组。');
        return null;
      }
      const last = lastAnalyzeRef.current;
      if (last && last.sessionId === sessionId && state.input_version === last.inputVersion) {
        // Exact replay of a response that was lost: same version, same content.
        return { version: last.inputVersion, payload: last.payload };
      }
      const nextVersion = (state.input_version ?? 0) + 1;
      if (state.input_version != null) {
        setError(
          `服务端已有 input_version=${state.input_version} 的本组分析；本次使用 input_version=${nextVersion}（不重复旧版本内容）。`,
        );
      }
      return { version: nextVersion, payload: buildAnalysisPayload(nextVersion) };
    }
    // 404: no authoritative server session yet, so version 1 is the first analysis.
    return { version: 1, payload: buildAnalysisPayload(1) };
  }
  async function recoverAnalysis() {
    if (busy || finishInFlightRef.current) return;
    if (sessionCheckingRef.current || storageFaultRef.current || uninitializedRef.current) {
      setError(SAFETY_STATE_CHECKING_NOTICE);
      return;
    }
    const sessionId = analysisRecovery?.session_id ?? sessionIdRef.current;
    if (!sessionId) return;
    setBusy(true);
    setError('');
    try {
      let state: SessionState;
      try {
        state = await getSessionState(sessionId);
      } catch (e) {
        if (isApiError(e) && e.status === 404) {
          setUninitialized(true);
          setError(SAFETY_SESSION_MISSING_NOTICE);
          return;
        }
        stateUnknownRef.current = true;
        setStateUnknown(true);
        setError(SAFETY_STATE_UNKNOWN_NOTICE);
        return;
      }
      if (state.status === 'expired') {
        expireCurrentSession(sessionId);
        return;
      }
      adoptSessionState(sessionId, state);
      if (state.proposal_status === 'accepted' || state.proposal_status === 'rejected') {
        setError('本组决定已在服务端提交，不能重新分析；请开始新的训练组。');
        return;
      }
      // 1) Prefer an exact replay when the server still has the same version and
      //    we captured the exact payload (authoritative cached report view).
      const last = lastAnalyzeRef.current;
      if (
        last &&
        last.sessionId === sessionId &&
        state.input_version != null &&
        last.inputVersion === state.input_version
      ) {
        try {
          const replay = await request<Report>('/sessions/analyze', {
            method: 'POST',
            body: JSON.stringify(last.payload),
          });
          applyAnalyzeResult(replay, last.payload);
          return;
        } catch (e) {
          if (!(isApiError(e) && (e.status === 409 || e.status === 503))) throw e;
          // Cached payload is gone; fall through to an explicit new version.
        }
      }
      // 2) Explicit new analysis on the authoritative input_version + 1. This is
      //    a new version, not a claimed idempotent retry of the old content.
      const version = (state.input_version ?? 0) + 1;
      const payload = buildAnalysisPayload(version);
      const result = await request<Report>('/sessions/analyze', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      applyAnalyzeResult(result, payload);
    } catch (e) {
      if (isApiError(e) && (e.status === 409 || e.status === 503)) {
        setError(
          '恢复分析未能确认（' +
            e.status +
            '）：已保留安全阻断；请再次点击恢复或刷新页面核对，不会重复旧版本内容。',
        );
        void refreshSessionState(sessionId);
      } else {
        setError('恢复分析失败：' + String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    sourceModeRef.current = sourceMode;
    live.current.source = sourceMode;
    if (sourceMode === 'simulation') {
      releaseCamera();
      return;
    }
    points.current = [];
    worldPoints.current = [];
    if (sourceMode === 'camera') {
      let cancelled = false;
      const requestToken = ++cameraLifecycle.current;
      let ownedStream: MediaStream | null = null;
      const requested = acquireCameraStream();
      requested
        .then((s) => {
          if (cancelled || !cameraOperationActive(requestToken)) {
            discardStaleCameraStream(s, requestToken);
            return;
          }
          // Do not replace an existing stream without stopping it first.
          if (stream.current && stream.current !== s) releaseCamera();
          stream.current = s;
          ownedStream = s;
          attachCameraTrackListeners(s);
          setCameraInterrupted(false);
          if (video.current) {
            video.current.srcObject = s;
            video.current
              .play()
              .then(() => {
                if (!cameraOperationActive(requestToken)) releaseCameraIfCurrent(s);
              })
              .catch(() => {
                // A failed playback cannot produce valid frames: release only
                // this request's stream, never a different newly-created one.
                releaseCameraIfCurrent(s);
                if (cameraOperationActive(requestToken)) {
                  setCameraInterrupted(true);
                  setError('无法播放摄像头画面；本次流已清理，请重新连接摄像头。');
                }
              });
          }
        })
        .catch((e) => {
          if (!cancelled && cameraOperationActive(requestToken)) {
            setCameraInterrupted(true);
            setError('无法打开摄像头：' + String(e));
          }
        });
      return () => {
        cancelled = true;
        if (cameraLifecycle.current === requestToken) cameraLifecycle.current += 1;
        if (ownedStream) releaseCameraIfCurrent(ownedStream);
      };
    }
    attachVideo();
    return () => {
      releaseCamera();
    };
  }, [sourceMode]);

  useEffect(() => {
    const node = video.current;
    if (!node || sourceMode !== 'video') return;
    if (running) node.play().catch(() => setError('无法播放所选视频，请换一个常见编码的文件。'));
    else node.pause();
  }, [running, sourceMode]);

  useEffect(() => {
    let frame = 0,
      last = performance.now(),
      lastDraw = 0;
    const loop = (now: number) => {
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      if (live.current.running) {
        live.current.elapsed += dt;
        if (live.current.source === 'simulation') {
          points.current = simulatedPose(live.current.elapsed * 1000, exercise);
          worldPoints.current = [];
          const result = engine.current.update(points.current, live.current.elapsed * 1000);
          metricRef.current = result;
          live.current.quality = result.quality;
          live.current.activityState = activityTracker.current.update(
            points.current,
            live.current.elapsed * 1000,
            result.quality,
          );
          live.current.lastPose = now;
        }
        if (dt <= 0.5 && live.current.quality && now - live.current.lastPose < 500) {
          live.current.observable += dt;
          if (live.current.activityState === 'work') live.current.work += dt;
          if (live.current.activityState === 'rest') live.current.rest += dt;
        }
      } else if (live.current.source === 'simulation') {
        points.current = simulatedPose(live.current.elapsed * 1000, exercise);
        worldPoints.current = [];
      }
      if (now - lastDraw > 80) {
        lastDraw = now;
        setElapsed(live.current.elapsed);
        if (live.current.source === 'simulation') setMetrics(metricRef.current);
        const v = video.current,
          currentWorker = worker.current,
          mainModel = poseMain.current;
        if (
          live.current.running &&
          live.current.source !== 'simulation' &&
          live.current.ready &&
          v &&
          v.readyState >= 2 &&
          !live.current.frameBusy &&
          (currentWorker || mainModel)
        ) {
          live.current.frameBusy = true;
          if (mainModel && !currentWorker) {
            try {
              const result = mainModel.detectForVideo(v, now);
              ingestPose.current({
                points: result.landmarks[0] ?? [],
                worldPoints: result.worldLandmarks[0] ?? [],
                activeElapsedMs: live.current.elapsed * 1000,
                generation: generation.current,
                aspectRatio: v.videoWidth / Math.max(v.videoHeight, 1),
              });
            } catch (error) {
              live.current.frameBusy = false;
              handlePoseRuntimeFailure('主线程姿态识别异常：' + String(error));
            }
          } else if (currentWorker) {
            const frameGeneration = generation.current;
            const frameElapsed = live.current.elapsed * 1000;
            createImageBitmap(v)
              .then((bitmap) => {
                if (
                  worker.current !== currentWorker ||
                  !live.current.running ||
                  frameGeneration !== generation.current
                ) {
                  bitmap.close();
                  live.current.frameBusy = false;
                  return;
                }
                currentWorker.postMessage(
                  {
                    type: 'frame',
                    bitmap,
                    timestamp: now,
                    activeElapsedMs: frameElapsed,
                    generation: frameGeneration,
                  },
                  [bitmap],
                );
              })
              .catch(() => {
                live.current.frameBusy = false;
              });
          } else {
            live.current.frameBusy = false;
          }
        }
        const p = points.current;
        const aspect = v && v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 4 / 3;
        const retargeted = p.length
          ? retargetPose(p, worldPoints.current, aspect, profileRef.current)
          : null;
        const overlay = canvas.current;
        if (overlay) {
          const { width, height } = syncCanvas(overlay);
          const ctx = overlay.getContext('2d');
          if (ctx) {
            const rect = drawVideoFrame(
              ctx,
              live.current.source === 'simulation' ? null : v,
              width,
              height,
            );
            if (showRawRef.current && p.length) drawRawPose(ctx, p, rect);
            if (retargeted) drawRetargetedOverlay(ctx, retargeted, rect);
          }
        }
        const body = avatar.current;
        if (body && retargeted) {
          const { width, height } = syncCanvas(body);
          const ctx = body.getContext('2d');
          if (ctx) drawAvatar(ctx, retargeted, width, height, 0.32 + Math.sin(now / 1800) * 0.18);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [exercise]);

  function reportDiscomfort() {
    const wasBlocked = discomfortBlockedRef.current;
    const existingReport = reportRef.current;
    discomfortBlockedRef.current = true;
    setDiscomfort(true);
    setDiscomfortBlocked(true);
    finishAbortRef.current?.abort();
    finishAbortRef.current = null;
    decisionAbortRef.current?.abort();
    decisionAbortRef.current = null;
    explanationTokenRef.current++;
    explanationAbortRef.current?.abort();
    explanationAbortRef.current = null;
    live.current.running = false;
    live.current.frameBusy = false;
    generation.current++;
    setRunning(false);
    releaseCamera();
    // An already generated report is never deleted here: it is historical
    // evidence and the UI marks it as pre-latch. Only stale explanation text is
    // cleared.
    setExplanation('');
    setError('');
    const targetSession = sessionIdRef.current ?? existingReport?.session_id ?? null;
    const sessionId = targetSession ?? ensureSession();
    if (sessionId) {
      sessionIdRef.current = sessionId;
      const isNewSafetyEvent = !safetyEventIdRef.current;
      const eventId = safetyEventIdRef.current ?? crypto.randomUUID();
      safetyEventIdRef.current = eventId;
      const activeSaved = writeStored(ACTIVE_SESSION_KEY, {
        session_id: sessionId,
        safety_latched: true,
        event_id: eventId,
      });
      let safetySaved = true;
      if (isNewSafetyEvent) {
        safetySaved = writeStored(
          LOCAL_SAFETY_KEY,
          {
            session_id: sessionId,
            event_id: eventId,
            server_confirmed: false,
            safety_version: runtimeMode === 'backend' ? safetyVersion : null,
          } satisfies StoredSafety,
        );
      }
      if (!activeSaved || !safetySaved) noteStorageFault();
      if (runtimeMode === 'backend') {
        // A discomfort belongs to the current group. After a committed decision the
        // group id comes from the report so the already-submitted decision is kept.
        const report = existingReport;
        if (report && report.proposal.status === 'pending') {
          setAnalysisRecovery({
            session_id: sessionId,
            reason: 'pre-latch',
            serverInputVersion: report.input_version,
            reportRecoverable: false,
            nextInputVersion: report.input_version + 1,
          });
          if (!wasBlocked) {
            setError(
              '已记录不适：本组报告生成于锁存之前，已作为历史证据失效，不能接受或拒绝；可重新生成阻断报告。',
            );
          }
        }
        void syncSafetyEvent(eventId);
      }
    }
  }
  function reset(): boolean {
    if (sessionCheckingRef.current) {
      setError(SAFETY_STATE_CHECKING_NOTICE);
      return false;
    }
    if (storageFaultRef.current) {
      setError(storageFaultNotice);
      return false;
    }
    if (uninitializedRef.current) {
      setError(SAFETY_SESSION_MISSING_NOTICE);
      return false;
    }
    if (stateUnknownRef.current) {
      setError(SAFETY_STATE_UNKNOWN_NOTICE);
      return false;
    }
    if (discomfortBlockedRef.current) {
      setError('本次训练已因不适停止，不能通过重置恢复本组；请结束本组查看阻断报告。');
      return false;
    }
    setCameraInterrupted(false);
    // Resetting after a report was generated discards the visible report: retire
    // the session so the next analysis cannot reuse input_version=1 for it.
    if (runtimeMode === 'backend' && sessionIdRef.current && reportRef.current) {
      retireSessionStorage();
    }
    recorder.current = new LandmarkRecorder();
    generation.current++;
    live.current.running = false;
    setRunning(false);
    engine.current = new ExerciseEngine(exercise, threshold);
    live.current.elapsed = 0;
    live.current.observable = 0;
    live.current.work = 0;
    live.current.rest = 0;
    live.current.activityState = 'unknown';
    activityTracker.current = new ActivityTracker();
    live.current.quality = false;
    metricRef.current = emptyMetrics;
    setMetrics(emptyMetrics);
    setElapsed(0);
    setReport(null);
    setExplanation('');
    setError('');
    if (video.current && sourceMode === 'video') {
      video.current.currentTime = 0;
      video.current.pause();
    }
    return true;
  }
  function attachVideo() {
    const node = video.current;
    if (!node || !videoUrl.current) return;
    node.srcObject = null;
    if (node.getAttribute('src') !== videoUrl.current) {
      node.src = videoUrl.current;
      node.load();
    }
  }
  function chooseSource(next: SourceMode) {
    if (sessionCheckingRef.current) {
      setError(SAFETY_STATE_CHECKING_NOTICE);
      return;
    }
    if (storageFaultRef.current) {
      setError(storageFaultNotice);
      return;
    }
    if (uninitializedRef.current) {
      setError(SAFETY_SESSION_MISSING_NOTICE);
      return;
    }
    if (stateUnknownRef.current) {
      setError(SAFETY_STATE_UNKNOWN_NOTICE);
      return;
    }
    if (discomfortBlockedRef.current) {
      setError('本次训练已因不适停止，不能通过切换输入源恢复本组。');
      return;
    }
    // Re-clicking the selected source is not a source change. Invalidating the
    // lifecycle token here would make an in-flight getUserMedia() request stale
    // or release a healthy current camera with no effect re-run to replace it.
    if (next === sourceModeRef.current) return;
    live.current.running = false;
    setRunning(false);
    cameraLifecycle.current += 1;
    sourceModeRef.current = next;
    releaseCamera();
    setSourceMode(next);
    setCameraInterrupted(false);
    setError('');
  }
  function onVideoFile(file?: File) {
    if (discomfortBlockedRef.current) {
      setError('本次训练已因不适停止，不能通过上传视频恢复本组。');
      return;
    }
    if (sessionCheckingRef.current) {
      setError(SAFETY_STATE_CHECKING_NOTICE);
      return;
    }
    if (storageFaultRef.current) {
      setError(storageFaultNotice);
      return;
    }
    if (uninitializedRef.current) {
      setError(SAFETY_SESSION_MISSING_NOTICE);
      return;
    }
    if (stateUnknownRef.current) {
      setError(SAFETY_STATE_UNKNOWN_NOTICE);
      return;
    }
    if (!file) return;
    if (!reset()) return;
    if (videoUrl.current) URL.revokeObjectURL(videoUrl.current);
    videoUrl.current = URL.createObjectURL(file);
    setVideoName(file.name);
    setError('');
    if (sourceMode === 'video') attachVideo();
    else chooseSource('video');
    requestAnimationFrame(attachVideo);
  }
  async function toggleRunning() {
    if (discomfortBlockedRef.current) {
      setError('本次训练已因不适停止，不能开始、继续或恢复本组；请结束本组查看阻断报告。');
      return;
    }
    if (cameraInterrupted) {
      setError('摄像头连接已中断：请先点击“重新连接摄像头并重置本组”，再开始训练。');
      return;
    }
    if (sessionCheckingRef.current) {
      setError(SAFETY_STATE_CHECKING_NOTICE);
      return;
    }
    if (storageFaultRef.current) {
      setError(storageFaultNotice);
      return;
    }
    if (uninitializedRef.current) {
      setError(SAFETY_SESSION_MISSING_NOTICE);
      return;
    }
    if (stateUnknownRef.current) {
      setError(SAFETY_STATE_UNKNOWN_NOTICE);
      return;
    }
    if (!validSettings()) return;
    if (discomfort) {
      reportDiscomfort();
      setError('已记录不适，训练保持停止；请结束本组查看阻断报告。');
      return;
    }
    if (sourceMode === 'video' && !videoUrl.current) {
      setError('请先上传一段包含全身的训练视频。');
      return;
    }
    let cameraRequestToken: number | null = null;
    if (sourceMode === 'camera' && !stream.current) {
      cameraRequestToken = ++cameraLifecycle.current;
      try {
        const s = await acquireCameraStream();
        if (!cameraOperationActive(cameraRequestToken)) {
          discardStaleCameraStream(s, cameraRequestToken);
          return;
        }
        if (stream.current && stream.current !== s) releaseCamera();
        stream.current = s;
        attachCameraTrackListeners(s);
        setCameraInterrupted(false);
        if (video.current) {
          video.current.srcObject = s;
          try {
            await video.current.play();
          } catch {
            if (cameraOperationActive(cameraRequestToken)) {
              releaseCameraIfCurrent(s);
              setCameraInterrupted(true);
              setError('无法播放摄像头画面；本次流已清理，请重新连接摄像头。');
            } else {
              discardStaleCameraStream(s, cameraRequestToken);
            }
            return;
          }
          if (!cameraOperationActive(cameraRequestToken)) {
            discardStaleCameraStream(s, cameraRequestToken);
            return;
          }
        }
      } catch (e) {
        if (cameraOperationActive(cameraRequestToken)) {
          setError('无法打开摄像头：' + String(e));
        }
        return;
      }
    }
    if (sourceMode === 'video') {
      attachVideo();
      try {
        await video.current?.play();
      } catch {
        setError('无法播放所选视频，请换一个常见编码的文件。');
        return;
      }
    }
    if (!live.current.running && (!sessionIdRef.current || reportRef.current)) {
      // A completed report/decision ends the previous group; the next group must
      // use a fresh session id so the backend cannot see a version conflict.
      if (!beginSession()) return;
      setReport(null);
      setExplanation('');
    }
    live.current.running = !live.current.running;
    engine.current.interrupt();
    recorder.current.boundary();
    generation.current++;
    live.current.activityState = 'unknown';
    activityTracker.current = new ActivityTracker();
    setRunning(live.current.running);
    setError('');
  }
  function exportLandmarks() {
    if (exercise !== 'squat' && exercise !== 'jumping_jack') return;
    const clip: ReplayClip = {
      format: 'localfit.landmarks.v1',
      clip_id: `clip-${crypto.randomUUID()}`,
      participant_id: 'TO_LABEL',
      exercise,
      source: sourceMode,
      evidence_kind: sourceMode === 'simulation' ? 'synthetic' : 'recorded_landmarks',
      scenario: 'TO_LABEL',
      reference_reps: null,
      count_eligible: null,
      exclusion_reason: '',
      down_threshold: threshold,
      truncated: recorder.current.truncated,
      frames: recorder.current.frames,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify([clip])], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${clip.clip_id}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function confirmFood(query = foodQuery, amount = grams) {
    if (!query.trim() && !customKcal) {
      setFoodError('请先输入食物名称，或填写自定义热量。');
      return;
    }
    setFoodBusy(true);
    setFoodError('');
    setShowFoodSuggest(false);
    try {
      const result = await request<{
        total_kcal: number;
        note: string;
        items?: {
          name: string;
          grams: number;
          total_kcal?: number;
          kcal?: number;
          matched: boolean;
        }[];
      }>('/nutrition/estimate', {
        method: 'POST',
        body: JSON.stringify([
          {
            query,
            grams: amount,
            kcal_per_100g: customKcal ? Number(customKcal) : undefined,
          },
        ]),
      });
      const items = (result.items ?? []).map((item) => ({
        name: item.name,
        grams: item.grams,
        total_kcal: item.total_kcal ?? item.kcal ?? 0,
        matched: item.matched,
      }));
      setFoodResult({ ...result, items });
      if (items[0] && (items[0].total_kcal > 0 || items[0].matched)) {
        setMeal((prev) => [
          ...prev,
          { name: items[0].name, grams: items[0].grams, total_kcal: items[0].total_kcal },
        ]);
        setMealConfirmed(false);
      } else {
        setFoodError(
          items[0]?.name
            ? '已匹配名称，但热量是 0。请改克数或填写自定义热量。'
            : '没有匹配到食物，请换个名称或填写自定义热量。',
        );
      }
    } catch (e) {
      setFoodError(String(e));
    } finally {
      setFoodBusy(false);
    }
  }
  async function finish() {
    if (finishInFlightRef.current) return;
    if (browserLatchRecovered && !report) {
      setError(
        '刷新后已恢复本组安全阻断，但实时计数、计时和画面不会恢复；不能用空数据生成报告。请查看已保存历史。',
      );
      return;
    }
    if (
      report &&
      (report.proposal.blocked ||
        report.proposal.status === 'accepted' ||
        report.proposal.status === 'rejected')
    ) {
      setTab('report');
      setError(
        report.proposal.blocked
          ? '本次训练已因不适结束，已有报告或决定保留；不能通过重复结束创建新的报告。'
          : '本组已结束并完成决定，不能重复结束；如需继续训练请开始新的训练组。',
      );
      return;
    }
    if (sessionCheckingRef.current) {
      setError(SAFETY_STATE_CHECKING_NOTICE);
      return;
    }
    if (storageFaultRef.current) {
      setError(storageFaultNotice);
      return;
    }
    if (uninitializedRef.current) {
      setError(SAFETY_SESSION_MISSING_NOTICE);
      return;
    }
    if (stateUnknownRef.current) {
      setError(SAFETY_STATE_UNKNOWN_NOTICE);
      return;
    }
    finishInFlightRef.current = true;
    generation.current++;
    live.current.running = false;
    setRunning(false);
    if (!validSettings()) {
      finishInFlightRef.current = false;
      return;
    }
    setBusy(true);
    setError('');
    const blockedAtRequest = discomfortBlockedRef.current;
    const controller = new AbortController();
    let attempt: { version: number; payload: AnalysisPayload } | null = null;
    try {
      // Always consult the authoritative session state first: this chooses the
      // next input_version and prevents same-version/different-content conflicts.
      attempt = await prepareAnalysis();
      if (!attempt) return;
      // A latch that arrived while the state was being read must not be overridden
      // by sending a normal (non-blocked) analysis.
      if (discomfortBlockedRef.current !== blockedAtRequest) {
        if (runtimeMode === 'backend' && sessionIdRef.current) {
          void reconcileLostAnalysis(sessionIdRef.current);
        }
        return;
      }
      // Remember exactly what was sent so a lost response can be replayed with the
      // same version and content instead of inventing a new version.
      const sentSession = sessionIdRef.current;
      if (sentSession) {
        lastAnalyzeRef.current = {
          sessionId: sentSession,
          inputVersion: attempt.version,
          payload: attempt.payload,
        };
      }
      finishAbortRef.current = controller;
      const result = await request<Report>('/sessions/analyze', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify(attempt.payload),
      });
      if (!blockedAtRequest && discomfortBlockedRef.current) {
        setError('生成报告期间记录了不适：本组保持阻断，该结果不作为继续训练建议。');
        setTab('training');
        return;
      }
      if (discomfortBlockedRef.current && !result.proposal.blocked && !result.safety_latched) {
        setError('生成报告期间记录了不适：本组保持阻断，不能使用该报告继续训练。');
        setTab('training');
        return;
      }
      applyAnalyzeResult(result, attempt.payload);
    } catch (e) {
      if (controller.signal.aborted) {
        // Aborted by a safety transition: do not assume the server failed to
        // commit; reconcile once the latch/state is known.
        if (runtimeMode === 'backend' && sessionIdRef.current) {
          void reconcileLostAnalysis(sessionIdRef.current);
        }
        return;
      }
      if (isApiError(e) && e.status === 410) {
        setError(SAFETY_EXPIRED_NOTICE + ' 本组报告未生成。');
        if (sessionIdRef.current) void refreshSessionState(sessionIdRef.current);
        return;
      }
      if (isApiError(e) && e.status === 409) {
        const id = sessionIdRef.current;
        if (id) {
          const outcome = await refreshSessionState(id);
          if (outcome === 'decided') {
            setError('本组决定已在服务端提交（409）：不能重复分析或覆盖已提交的决定。');
            return;
          }
          if (outcome === 'latched') {
            setError('本组已锁存（409）：本次报告未生成，安全阻断仍然有效。');
            return;
          }
          if (outcome === 'uninitialized' || outcome === 'unknown') return;
        }
        if (id) {
          setAnalysisRecovery({
            session_id: id,
            reason: 'lost',
            serverInputVersion: inputVersionRef.current,
            reportRecoverable: false,
            nextInputVersion: inputVersionRef.current + 1,
          });
        }
        setError(
          '本组分析版本冲突（409）：可能已有提交但报告不可恢复。不会重复相同版本内容；请点击「核对并恢复本组报告」。',
        );
        return;
      }
      if (isApiError(e) && e.status === 503) {
        if (sessionIdRef.current) await refreshSessionState(sessionIdRef.current);
        setError(
          '服务端未能确认本次分析（503）：可能已保存，也可能未保存。已刷新状态核对；不会重复相同版本内容，请核对后再操作。',
        );
        return;
      }
      setError(String(e));
      if (runtimeMode === 'backend' && sessionIdRef.current) {
        void refreshSessionState(sessionIdRef.current);
      }
    } finally {
      if (finishAbortRef.current === controller) finishAbortRef.current = null;
      finishInFlightRef.current = false;
      setBusy(false);
    }
  }
  function decisionGates(): string | null {
    if (sessionCheckingRef.current) return SAFETY_STATE_CHECKING_NOTICE;
    if (storageFaultRef.current) return storageFaultNotice;
    if (uninitializedRef.current) return SAFETY_SESSION_MISSING_NOTICE;
    if (stateUnknownRef.current) return SAFETY_STATE_UNKNOWN_NOTICE;
    return null;
  }
  async function accept() {
    if (!report) return;
    const gate = decisionGates();
    if (gate) {
      setError(gate);
      return;
    }
    if (report.proposal.blocked || discomfortBlockedRef.current) {
      setError('本次训练已因不适阻断，不能确认或应用下一组建议。');
      return;
    }
    if (remoteDecision) {
      setError('服务端已经提交本组决定，不能再次提交相反或重复决定。');
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    decisionAbortRef.current = controller;
    try {
      const next = await acceptReport(report, controller.signal);
      if (next.proposal.blocked || next.safety_latched) {
        // The backend preserved/created authoritative safety state.
        setReport(next);
        if (next.proposal.status === 'accepted' || next.proposal.status === 'rejected') {
          setRemoteDecision({
            session_id: report.session_id,
            status: next.proposal.status,
            decided_at: next.proposal.decided_at ?? null,
            recoverable: true,
          });
        }
        enterBlockedState();
        setError('本次训练已因不适阻断：已提交的决定保留，但不能继续训练。');
        return;
      }
      if (controller.signal.aborted) return;
      if (discomfortBlockedRef.current) {
        setError('本次训练已因不适阻断，不能确认或应用下一组建议。');
        return;
      }
      if (next.safety_version != null) setSafetyVersionValue(next.safety_version);
      if (next.input_version != null) inputVersionRef.current = next.input_version;
      setReport(next);
      setTarget(next.proposal.target_reps);
      completeSession();
    } catch (e) {
      if (!controller.signal.aborted) void handleDecisionError(e, report);
    } finally {
      if (decisionAbortRef.current === controller) decisionAbortRef.current = null;
      setBusy(false);
    }
  }
  async function reject() {
    if (!report) return;
    const gate = decisionGates();
    if (gate) {
      setError(gate);
      return;
    }
    if (report.proposal.blocked || discomfortBlockedRef.current) {
      setError('本次训练已因不适阻断，不能确认或拒绝下一组建议。');
      return;
    }
    if (remoteDecision) {
      setError('服务端已经提交本组决定，不能再次提交相反或重复决定。');
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    decisionAbortRef.current = controller;
    try {
      const next = await decideReport(report, 'reject', controller.signal);
      if (next.proposal.blocked || next.safety_latched) {
        setReport(next);
        if (next.proposal.status === 'accepted' || next.proposal.status === 'rejected') {
          setRemoteDecision({
            session_id: report.session_id,
            status: next.proposal.status,
            decided_at: next.proposal.decided_at ?? null,
            recoverable: true,
          });
        }
        enterBlockedState();
        setError('本次训练已因不适阻断：已提交的决定保留，但不能继续训练。');
        return;
      }
      if (controller.signal.aborted) return;
      if (discomfortBlockedRef.current) {
        setError('本次训练已因不适阻断，不能确认或拒绝下一组建议。');
        return;
      }
      if (next.safety_version != null) setSafetyVersionValue(next.safety_version);
      if (next.input_version != null) inputVersionRef.current = next.input_version;
      setReport(next);
      completeSession();
    } catch (e) {
      if (!controller.signal.aborted) void handleDecisionError(e, report);
    } finally {
      if (decisionAbortRef.current === controller) decisionAbortRef.current = null;
      setBusy(false);
    }
  }
  async function loadExplanation() {
    if (!report) return;
    const gate = decisionGates();
    if (gate) {
      setError(gate);
      return;
    }
    if (report.proposal.blocked || discomfortBlockedRef.current) {
      setError('本次训练已因不适阻断，不能继续使用旧的解释建议。');
      return;
    }
    const requestSession = report.session_id;
    const requestVersion = report.input_version;
    const token = ++explanationTokenRef.current;
    const controller = new AbortController();
    explanationAbortRef.current = controller;
    const stale = () =>
      controller.signal.aborted ||
      token !== explanationTokenRef.current ||
      discomfortBlockedRef.current ||
      reportRef.current?.session_id !== requestSession ||
      reportRef.current?.input_version !== requestVersion;
    try {
      const r = await request<ExplanationResponse>(
        `/sessions/${encodeURIComponent(requestSession)}/explanation`,
        { method: 'POST', signal: controller.signal },
      );
      if (stale()) return;
      if (r.blocked || r.safety_latched) {
        setExplanation(r.text);
        enterBlockedState();
        setError('服务端已锁存：解释已被安全阻断内容替换，不能作为继续训练建议。');
        return;
      }
      if (r.safety_version != null) setSafetyVersionValue(r.safety_version);
      setExplanation(r.text + '（' + r.runtime + '）');
    } catch (e) {
      if (stale()) return;
      if (isApiError(e) && e.status === 410) {
        setError(SAFETY_EXPIRED_NOTICE);
        setReport(null);
        void refreshSessionState(requestSession);
        return;
      }
      if (isApiError(e) && e.status === 409) {
        setError('服务端安全状态或报告已变化（409）：已刷新权威状态，请勿继续使用旧解释。');
        void refreshSessionState(requestSession);
        return;
      }
      setError(String(e));
    } finally {
      if (explanationAbortRef.current === controller) explanationAbortRef.current = null;
    }
  }
  function validSettings() {
    if (
      !Number.isFinite(weight) ||
      weight < 30 ||
      weight > 250 ||
      !Number.isFinite(height) ||
      height < 120 ||
      height > 220 ||
      !Number.isFinite(age) ||
      age < 14 ||
      age > 80 ||
      !Number.isInteger(target) ||
      target < 1 ||
      target > 100
    ) {
      setError('请填写有效设置：体重 30–250kg、身高 120–220cm、年龄 14–80 岁、目标 1–100 次。');
      return false;
    }
    return true;
  }
  async function loadSavedHistory() {
    if (historyBusy) return;
    setHistoryBusy(true);
    setHistoryStatus(null);
    try {
      const items = await request<Report[]>('/history');
      setHistory(items);
      if (items.length === 0) {
        setHistoryStatus({
          kind: 'info',
          text:
            report?.saved === false
              ? '已读取本机历史：暂无已保存记录。当前报告 saved=false，JSON 导出不会写入历史。'
              : '已读取本机历史：暂无已保存记录。',
        });
      } else {
        setHistoryStatus({ kind: 'info', text: `已读取 ${items.length} 条本机历史记录。` });
      }
    } catch (e) {
      setHistoryStatus({ kind: 'error', text: `读取已保存记录失败：${String(e)}` });
    } finally {
      setHistoryBusy(false);
    }
  }
  function exportReport() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `localfit-${report.session_id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function exportHistory() {
    if (!history.length) {
      setError(
        '历史尚未加载或为空：请先在复盘页点击“读取已保存记录”。历史导出与当前报告导出是不同操作。',
      );
      return;
    }
    try {
      // Export the records actually loaded from the mode's history store, not
      // the current report/lastReport cache. The array is the existing Report
      // schema (trace timestamps, completion, quality evidence, proposal, source).
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `localfit-history-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      // Keep the blob URL alive until the browser has started the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError('');
    } catch (e) {
      setError('导出历史失败：' + String(e));
    }
  }
  const nav = [
    ['training', '训练空间', Activity],
    ['report', '训练复盘', ClipboardList],
    ['nutrition', '饮食记录', Leaf],
    ['team', '项目协作', Users],
  ] as const;
  const progress = Math.min(100, (metrics.reps / target) * 100);
  const daily = dailyRequirement({
    weightKg: weight,
    heightCm: height,
    ageYears: age,
    sex,
    activity,
    goal: 'habit',
  });
  const liveBurn =
    Number.isFinite(weight) && weight >= 30 && weight <= 250
      ? sessionEnergy({
          exercise,
          weightKg: weight,
          activeSeconds: live.current.elapsed,
          observableSeconds: live.current.observable,
          workSeconds: live.current.work,
          restSeconds: live.current.rest,
          reps: metrics.reps,
          repDetails: metrics.squatReps,
        })
      : {
          available: false,
          low_kcal: 0,
          high_kcal: 0,
          note: '请填写有效体重后估算；不会用默认体重替代无效输入。',
        };
  const sourceLabel =
    sourceMode === 'camera'
      ? '摄像头 · 本地姿态识别'
      : sourceMode === 'video'
        ? '上传视频 · 骨骼重定向'
        : '模拟动作回放 · 非真实测量';
  const canStart =
    (sourceMode === 'simulation' ||
      (sourceMode === 'video' && Boolean(videoUrl.current || videoName)) ||
      sourceMode === 'camera') &&
    !(sourceMode !== 'simulation' && poseStatus === 'failed');
  const reportFinished =
    report !== null &&
    (report.proposal.blocked ||
      report.proposal.status === 'accepted' ||
      report.proposal.status === 'rejected');

  return (
    <div className="layout">
      <aside className="sidebar">
        <a className="brand" href="#">
          <span className="brand-icon">
            <Activity size={26} />
          </span>
          <span>
            LocalFit<small>本地健身教练</small>
          </span>
        </a>
        <div className="workspace-label">YOUR WELLNESS SPACE</div>
        <nav>
          {nav.map(([key, label, Icon]) => (
            <button
              key={key}
              className={tab === key ? 'nav active' : 'nav'}
              onClick={() => setTab(key)}
            >
              <Icon size={19} />
              {label}
              {tab === key && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="privacy-card">
            <ShieldCheck size={24} />
            <strong>你的训练，留在本地</strong>
            <p>原始音视频不上传。保存摘要由你决定。</p>
            <span className="tiny-pill">LOCAL FIRST</span>
          </div>
          <div className="version">开源原型 · v0.1.0</div>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="eyebrow">MOVE WITH CONFIDENCE</span>
            <h1>
              {tab === 'training'
                ? '让每一次训练，都有反馈。'
                : tab === 'report'
                  ? '看见进步，也理解调整。'
                  : tab === 'nutrition'
                    ? '记录饮食，从确认份量开始。'
                    : '把想法，变成共同的进度。'}
            </h1>
            <p>居家运动 · 原创演示骨架 · 可解释的规则协作</p>
          </div>
          <span className={'status ' + (apiReady ? 'online' : 'browser')}>
            <i />
            {runtimeMode === 'browser'
              ? '浏览器规则模式'
              : apiReady
                ? '本地后端已连接'
                : '后端不可用 · 不自动降级'}
          </span>
        </header>
        {error && (
          <div role="alert" className="alert">
            {error}
          </div>
        )}
        {discomfortBlocked && (
          <div role="alert" className="alert safety-stop">
            <strong>
              {report?.proposal.blocked ? '本次训练已因不适结束。' : '本次训练已因不适停止。'}
            </strong>{' '}
            {report?.proposal.blocked
              ? '阻断报告已生成，不能确认或应用下一组建议。'
              : report?.proposal.status === 'accepted' || report?.proposal.status === 'rejected'
                ? '此前已提交的计划决定仍保留在复盘记录中，但不会继续训练。'
                : browserLatchRecovered && !report
                  ? '刷新后安全阻断已恢复，但本组计数、计时和实时画面不会恢复。不会用空数据生成报告；本组不能继续，也不会自动开始新组。可只读查看已保存历史。'
                  : SAFETY_STOP_NOTICE}
            {browserLatchRecovered && !report && (
              <div className="safety-sync">
                <button
                  className="secondary"
                  onClick={() => {
                    setTab('report');
                    void loadSavedHistory();
                  }}
                >
                  查看已保存历史
                </button>
              </div>
            )}
            {runtimeMode === 'backend' && (
              <div className="safety-sync">
                {safetySync === 'syncing' && <p role="status">正在向服务端同步本次不适事件…</p>}
                {safetySync === 'pending' && (
                  <>
                    <p role="status">{SAFETY_SYNC_PENDING_NOTICE}</p>
                    <button className="secondary" onClick={retrySafetySync}>
                      重试服务端同步（同一事件 ID）
                    </button>
                  </>
                )}
                {safetySync === 'confirmed' && (
                  <p role="status">
                    服务端已确认记录本次不适事件（safety_version {safetyVersion ?? '-'}）。
                  </p>
                )}
                {safetySync === 'expired' && (
                  <>
                    <p role="status">{SAFETY_EXPIRED_NOTICE}</p>
                    <button className="secondary" onClick={startNewSessionAfterExpiry}>
                      开始新的训练组
                    </button>
                  </>
                )}
                {safetySync === 'idle' && <p role="status">本地已阻断；服务端同步尚未开始。</p>}
              </div>
            )}
          </div>
        )}
        {stateUnknown && (
          <div role="alert" className="alert safety-stop">
            <strong>服务端安全状态未确认</strong> {SAFETY_STATE_UNKNOWN_NOTICE}
            <button
              className="secondary"
              onClick={() => {
                if (sessionIdRef.current) void refreshSessionState(sessionIdRef.current);
              }}
            >
              重试状态查询
            </button>
          </div>
        )}
        {poseStatus === 'failed' && (
          <div role="alert" className="alert safety-stop">
            <strong>姿态模型加载失败</strong>{' '}
            当前无法处理摄像头/视频动作；模拟模式仍可使用。请检查本地
            models/wasm 资源后重试。
            <button className="secondary" onClick={retryPose}>
              重试模型加载
            </button>
          </div>
        )}
        {cameraInterrupted && (
          <div role="alert" className="alert safety-stop">
            <strong>摄像头连接已中断</strong>{' '}
            本次训练已停止计时；重新连接会重置本组计数，不会把无画面时间算作训练。
            <button
              className="secondary"
              disabled={stateUnknown}
              onClick={() => void reconnectCamera()}
            >
              重新连接摄像头并重置本组
            </button>
          </div>
        )}
        {runtimeMode === 'backend' && sessionChecking && (
          <div role="status" className="alert safety-stop">
            <strong>正在核对服务端会话状态</strong> {SAFETY_STATE_CHECKING_NOTICE}
          </div>
        )}
        {runtimeMode === 'backend' && storageFault && (
          <div role="alert" className="alert safety-stop">
            <strong>浏览器存储不可用</strong> {storageFaultNotice}
          </div>
        )}
        {runtimeMode === 'backend' && sessionUninitialized && (
          <div role="alert" className="alert safety-stop">
            <strong>会话无法恢复</strong> {SAFETY_SESSION_MISSING_NOTICE}
            <div className="inline-actions">
              <button
                className="secondary"
                onClick={() => {
                  const sessionId = sessionIdRef.current;
                  if (sessionId) void refreshSessionState(sessionId);
                }}
              >
                重试状态查询
              </button>
              <button className="secondary danger" onClick={discardUninitializedSession}>
                丢弃本组并创建新会话
              </button>
            </div>
          </div>
        )}
        {runtimeMode === 'backend' && analysisRecovery && !sessionChecking && (
          <div role="alert" className="alert safety-stop">
            <strong>
              {analysisRecovery.reason === 'pre-latch'
                ? '本组报告生成于安全锁存之前'
                : '分析提交状态待核对'}
            </strong>{' '}
            {analysisRecovery.reason === 'pre-latch'
              ? '该报告已作为历史证据失效，不能接受或拒绝；服务端安全阻断仍然有效。'
              : SAFETY_ANALYSIS_LOST_NOTICE}
            <div className="inline-actions">
              <button className="secondary" disabled={busy} onClick={() => void recoverAnalysis()}>
                核对并恢复本组报告
              </button>
            </div>
          </div>
        )}
        {runtimeMode === 'backend' && remoteDecision && (
          <div role="status" className="alert safety-stop">
            <strong>服务端已提交本组决定</strong>{' '}
            {remoteDecision.status === 'accepted' ? '接受' : '拒绝'}
            {remoteDecision.decided_at ? `（${remoteDecision.decided_at}）` : ''}
            ：该决定是已提交事实，不能用相反决定覆盖；
            {!report && !remoteDecision.recoverable ? '本页报告不可恢复，仅保留该决定事实；' : ''}
            如需继续训练请开始新的训练组。
          </div>
        )}
        <div className="panel" style={{ marginBottom: 20 }}>
          <strong>
            {runtimeMode === 'browser'
              ? '浏览器计算与标签页内历史'
              : '本地后端计算与授权后的 SQLite 历史'}{' '}
            · {strictOffline ? '仅本机/同源模型资源' : '允许公共资源加载'}
          </strong>
          <p>
            模式在本页会话期间固定，请求失败不会自动切换。切换链接会重载页面并结束当前训练；浏览器摘要关闭标签页后不保留。完全断网需提前下载资源并启动本地服务，公网演示不代表离线安装。
          </p>
          <div className="inline-actions">
            <a className="secondary" href="?runtime=browser">
              浏览器规则 · 仅同源资源
            </a>
            {!location.hostname.endsWith('github.io') && (
              <a className="secondary" href="?runtime=backend">
                本地后端 · 仅同源资源
              </a>
            )}
            <a className="secondary" href={`?runtime=${runtimeMode}&assets=online`}>
              在线资源模式（允许 CDN）
            </a>
          </div>
        </div>
        <div style={{ display: tab === 'training' ? 'block' : 'none' }}>
          <div className="section-top">
            <div>
              <h2>今日训练空间</h2>
              <p>
                优先验收深蹲和开合跳；其余动作保留实验入口。骨架用于展示，不测量体型或推断肌肉。
              </p>
            </div>
            <div className="segmented">
              <button
                disabled={
                  running ||
                  busy ||
                  discomfortBlocked ||
                  sessionChecking ||
                  storageFault ||
                  sessionUninitialized ||
                  stateUnknown
                }
                className={sourceMode === 'simulation' ? 'selected' : ''}
                onClick={() => chooseSource('simulation')}
              >
                模拟演示
              </button>
              <button
                disabled={
                  running ||
                  busy ||
                  discomfortBlocked ||
                  sessionChecking ||
                  storageFault ||
                  sessionUninitialized ||
                  stateUnknown
                }
                className={sourceMode === 'camera' ? 'selected' : ''}
                onClick={() => chooseSource('camera')}
              >
                真实摄像头
              </button>
              <button
                disabled={
                  running ||
                  busy ||
                  discomfortBlocked ||
                  sessionChecking ||
                  storageFault ||
                  sessionUninitialized ||
                  stateUnknown
                }
                className={sourceMode === 'video' ? 'selected' : ''}
                onClick={() => fileInput.current?.click()}
              >
                上传视频
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="video/*"
              hidden
              disabled={stateUnknown}
              onChange={(e) => onVideoFile(e.target.files?.[0])}
            />
          </div>
          <div className="training-grid">
            <div className="stage-stack">
              <section className="camera-card">
                <div className="camera-heading">
                  <span>
                    <Camera size={16} />
                    {sourceLabel}
                    {sourceMode === 'video' && videoName ? ` · ${videoName}` : ''}
                  </span>
                  <span className="camera-chip">
                    {sourceMode === 'simulation'
                      ? 'DEMO'
                      : poseStatus === 'worker'
                        ? bodyModel.toUpperCase()
                        : poseStatus === 'main-thread'
                          ? `${bodyModel.toUpperCase()} · 主线程`
                          : poseStatus === 'failed'
                            ? '模型加载失败'
                            : poseStatus === 'retrying'
                              ? '模型重试中'
                              : '模型加载中'}
                  </span>
                </div>
                <div className="dual-view">
                  <div className="viewport">
                    <video ref={video} muted playsInline loop />
                    <canvas ref={canvas} />
                    {sourceMode === 'simulation' && (
                      <div className="demo-watermark">SIMULATION</div>
                    )}
                    <div className="view-tag">
                      <span className={metrics.quality ? 'dot-good' : 'dot-wait'} />
                      {metrics.quality ? '骨骼已对齐人体' : '等待有效动作'}
                    </div>
                  </div>
                  <div className="avatar-pane">
                    <canvas ref={avatar} />
                    <div className="avatar-label">
                      原创演示骨架 · {bodyModel === 'smplx' ? '扩展关节' : '身体关节'}
                    </div>
                  </div>
                </div>
                <div className="camera-footer">
                  <LockKeyhole size={15} />
                  <span>画面只在当前设备处理 · 亮色为重定向骨骼</span>
                  <span>
                    {Math.floor(elapsed / 60)
                      .toString()
                      .padStart(2, '0')}
                    :
                    {Math.floor(elapsed % 60)
                      .toString()
                      .padStart(2, '0')}
                  </span>
                </div>
              </section>
            </div>
            <section className="coach-card">
              <div className="card-kicker">YOUR TRAINING</div>
              <label className="field-label" htmlFor="exercise-search">
                当前动作
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  disabled={
                    running ||
                    busy ||
                    discomfortBlocked ||
                    sessionChecking ||
                    storageFault ||
                    sessionUninitialized ||
                    stateUnknown
                  }
                  checked={showExperimental}
                  onChange={(e) => {
                    if (stateUnknownRef.current) {
                      setError(SAFETY_STATE_UNKNOWN_NOTICE);
                      return;
                    }
                    setShowExperimental(e.target.checked);
                    if (!e.target.checked && exercise !== 'squat' && exercise !== 'jumping_jack')
                      setExercise('squat');
                  }}
                />
                显示其他实验动作（未完成真实验收）
              </label>
              <input
                id="exercise-search"
                placeholder="搜索动作，如 深蹲 / 俯卧撑 / 波比"
                disabled={
                  running ||
                  busy ||
                  discomfortBlocked ||
                  sessionChecking ||
                  storageFault ||
                  sessionUninitialized
                }
                value={exerciseQuery}
                onChange={(e) => setExerciseQuery(e.target.value)}
              />
              <select
                id="exercise"
                disabled={
                  running ||
                  busy ||
                  discomfortBlocked ||
                  sessionChecking ||
                  storageFault ||
                  sessionUninitialized ||
                  stateUnknown
                }
                value={exercise}
                onChange={(e) => {
                  if (stateUnknownRef.current) {
                    setError(SAFETY_STATE_UNKNOWN_NOTICE);
                    return;
                  }
                  if (isExercise(e.target.value)) setExercise(e.target.value);
                }}
              >
                {EXERCISE_GROUPS.map((group) => {
                  const q = exerciseQuery.trim().toLowerCase();
                  const items = EXERCISE_IDS.filter((id) => {
                    const item = EXERCISES[id];
                    if (item.group !== group) return false;
                    if (!showExperimental && id !== 'squat' && id !== 'jumping_jack') return false;
                    if (!q) return true;
                    return (
                      item.name.includes(exerciseQuery) ||
                      id.includes(q) ||
                      exerciseLabel(id).includes(exerciseQuery)
                    );
                  });
                  if (!items.length) return null;
                  return (
                    <optgroup key={group} label={group}>
                      {items.map((id) => (
                        <option key={id} value={id}>
                          {exerciseLabel(id)}
                          {id === 'squat' || id === 'jumping_jack' ? ' · 核心待实测' : ' · 实验性'}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              <div className="rep-number">
                {metrics.reps}
                <span>/ {target} 次</span>
              </div>
              <div className="progress">
                <div style={{ width: progress + '%' }} />
              </div>
              <div className="rep-meta">
                <span>本组完成度</span>
                <strong>{Math.round(progress)}%</strong>
              </div>
              {exercise === 'squat' && (
                <p className="muted">
                  达到实验幅度 {metrics.squatReps.filter((r) => r.rom === 'within_rule').length} 次
                  · 幅度不足 {metrics.squatReps.filter((r) => r.rom === 'below_rule').length} 次 ·
                  不可评价 {metrics.squatReps.filter((r) => r.rom === 'unobservable').length} 次
                  <br />
                  次数与幅度分开记录，不代表动作正确或安全。
                </p>
              )}
              <div className="coach-tip">
                <Sparkles size={19} />
                <div>
                  <strong>当前教练提示</strong>
                  <p>
                    {metrics.hint}
                    {!metrics.quality && metrics.unknown_reason
                      ? `（${metrics.unknown_reason}）`
                      : ''}
                  </p>
                </div>
              </div>
              <div className="controls">
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !canStart ||
                    discomfortBlocked ||
                    stateUnknown ||
                    sessionChecking ||
                    storageFault ||
                    sessionUninitialized
                  }
                  onClick={() => void toggleRunning()}
                >
                  {running ? <Pause size={17} /> : <Play size={17} />}{' '}
                  {storageFault
                    ? '存储不可用'
                    : sessionChecking
                      ? '正在核对状态…'
                      : sessionUninitialized
                        ? '会话待处理'
                        : stateUnknown
                          ? '状态未确认'
                          : discomfortBlocked
                            ? '本次训练已停止'
                            : running
                              ? '暂停'
                              : '开始 / 继续'}
                </button>
                <button
                  className="icon-button"
                  aria-label="重置本组"
                  disabled={
                    busy ||
                    discomfortBlocked ||
                    sessionChecking ||
                    storageFault ||
                    sessionUninitialized ||
                    stateUnknown
                  }
                  onClick={reset}
                >
                  <RotateCcw size={18} />
                </button>
                <button
                  className="icon-button"
                  aria-label="上传视频"
                  disabled={
                    busy ||
                    running ||
                    discomfortBlocked ||
                    sessionChecking ||
                    storageFault ||
                    sessionUninitialized ||
                    stateUnknown
                  }
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={18} />
                </button>
              </div>
              <button
                className="finish-button"
                disabled={
                  busy ||
                  reportFinished ||
                  (browserLatchRecovered && !report) ||
                  sessionChecking ||
                  storageFault ||
                  sessionUninitialized ||
                  stateUnknown
                }
                onClick={finish}
              >
                {busy
                  ? '生成报告中…'
                  : reportFinished
                    ? '本次训练已结束'
                    : browserLatchRecovered && !report
                      ? '本组数据未恢复'
                      : sessionChecking
                      ? '正在核对状态…'
                      : '结束本组并复盘'}
                <ArrowRight size={17} />
              </button>
              {(exercise === 'squat' || exercise === 'jumping_jack') &&
                sourceMode !== 'simulation' && (
                  <details>
                    <summary>算法评测采集</summary>
                    <label>
                      <input
                        type="checkbox"
                        checked={captureLandmarks}
                        disabled={!captureLandmarks && (running || elapsed > 0)}
                        onChange={(event) => {
                          setCaptureLandmarks(event.target.checked);
                          recorder.current = new LandmarkRecorder();
                        }}
                      />
                      我同意在本页内存记录关键点，用于本次算法评测
                    </label>
                    <p className="muted">
                      如需采集本组数据，请在开始训练前完成授权；训练开始后不能补开本组采集。仅记录坐标与训练时间，不含影像。
                      手动导出后交标注人员；重置本组或关闭页面会清空，最多 20,000 帧。
                    </p>
                    {recorder.current.truncated && (
                      <p role="alert">
                        记录已达到上限，请重录较短片段；截断记录不能用于完整组评测。
                      </p>
                    )}
                    <button
                      disabled={running || recorder.current.frames.length === 0}
                      onClick={exportLandmarks}
                    >
                      导出关键点评测 JSON（{recorder.current.frames.length} 帧）
                    </button>
                  </details>
                )}
            </section>
          </div>
          <div className="bottom-grid body-grid">
            <section className="panel">
              <h3>演示骨架与用户输入参数</h3>
              <div className="fields">
                <label>
                  身高 cm
                  <input
                    type="number"
                    min="120"
                    max="220"
                    disabled={running || busy}
                    value={height}
                    onChange={(e) => setHeight(Number(e.target.value))}
                  />
                </label>
                <label>
                  体重 kg
                  <input
                    type="number"
                    min="30"
                    max="250"
                    disabled={running || busy}
                    value={weight}
                    onChange={(e) => setWeight(Number(e.target.value))}
                  />
                </label>
                <label>
                  年龄
                  <input
                    type="number"
                    min="14"
                    max="80"
                    disabled={running || busy}
                    value={age}
                    onChange={(e) => setAge(Number(e.target.value))}
                  />
                </label>
              </div>
              <div className="fields">
                <label>
                  性别
                  <select
                    disabled={running || busy}
                    value={sex}
                    onChange={(e) => setSex(e.target.value as Sex)}
                  >
                    <option value="unspecified">不指定</option>
                    <option value="female">女</option>
                    <option value="male">男</option>
                  </select>
                </label>
                <label>
                  日常活动
                  <select
                    disabled={running || busy}
                    value={activity}
                    onChange={(e) => setActivity(e.target.value as ActivityLevel)}
                  >
                    <option value="sedentary">久坐</option>
                    <option value="light">轻度</option>
                    <option value="moderate">中等</option>
                    <option value="active">活跃</option>
                  </select>
                </label>
              </div>
              <div className="calorie-need">
                <span>每日热量需求（维持）</span>
                <strong>
                  {daily.need_kcal}
                  <small> kcal</small>
                </strong>
                <p>
                  BMR {daily.bmr_kcal} · TDEE {daily.tdee_kcal}
                  。这是每日需求情景，不是本组消耗。{daily.note}
                </p>
              </div>
              <div className="calorie-need session-burn">
                <span>本组消耗估算</span>
                <strong>
                  {liveBurn.available ? `${liveBurn.low_kcal}–${liveBurn.high_kcal}` : '待有效片段'}
                  <small> kcal</small>
                </strong>
                <p>{liveBurn.note}</p>
              </div>
              <label className="field-label" htmlFor="body-model">
                人体模型
              </label>
              <select
                id="body-model"
                disabled={running || busy}
                value={bodyModel}
                onChange={(e) => setBodyModel(e.target.value as BodyModel)}
              >
                <option value="smpl">原创骨架 · 身体关节</option>
                <option value="smplx">原创骨架 · 扩展关节（含推定部分）</option>
              </select>
              <label className="slider-label">
                上肢肌肉 <strong>{Math.round(muscleUpper * 100)}%</strong>
                <input
                  type="range"
                  min="0"
                  max="100"
                  disabled={running || busy}
                  value={Math.round(muscleUpper * 100)}
                  onChange={(e) => setMuscleUpper(Number(e.target.value) / 100)}
                />
              </label>
              <label className="slider-label">
                核心肌肉 <strong>{Math.round(muscleCore * 100)}%</strong>
                <input
                  type="range"
                  min="0"
                  max="100"
                  disabled={running || busy}
                  value={Math.round(muscleCore * 100)}
                  onChange={(e) => setMuscleCore(Number(e.target.value) / 100)}
                />
              </label>
              <label className="slider-label">
                下肢肌肉 <strong>{Math.round(muscleLower * 100)}%</strong>
                <input
                  type="range"
                  min="0"
                  max="100"
                  disabled={running || busy}
                  value={Math.round(muscleLower * 100)}
                  onChange={(e) => setMuscleLower(Number(e.target.value) / 100)}
                />
              </label>
              <p className="muted">
                原创示意骨架按用户输入调整外观，不使用官方 SMPL/SMPL-X 权重或派生参数。
                骨长和粗细是展示假设，不是摄像头测量值；未观测到的手指等关节只作示意。
              </p>
            </section>
            <section className="panel">
              <h3>训练设置</h3>
              <div className="fields">
                <label>
                  本组目标次数
                  <input
                    type="number"
                    min="1"
                    max="100"
                    disabled={
                      running ||
                      busy ||
                      discomfortBlocked ||
                      sessionChecking ||
                      storageFault ||
                      sessionUninitialized
                    }
                    value={target}
                    onChange={(e) => setTarget(Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showRaw}
                  onChange={(e) => setShowRaw(e.target.checked)}
                />
                同时显示原始 MediaPipe 细线
              </label>
              <details>
                <summary>实验参数与机位要求</summary>
                <p>
                  {EXERCISES[exercise].hint} 当前共 {EXERCISE_IDS.length} 个动作。平板和靠墙静蹲按每
                  8 秒计 1 次。
                </p>
                <label>
                  深蹲下降角度阈值（待验证）
                  <input
                    type="range"
                    min="85"
                    max="125"
                    disabled={
                      running ||
                      busy ||
                      discomfortBlocked ||
                      sessionChecking ||
                      storageFault ||
                      sessionUninitialized ||
                      stateUnknown
                    }
                    value={threshold}
                    onChange={(e) => {
                      if (stateUnknownRef.current) {
                        setError(SAFETY_STATE_UNKNOWN_NOTICE);
                        return;
                      }
                      setThreshold(Number(e.target.value));
                    }}
                  />
                  {threshold}°
                </label>
              </details>
            </section>
            <section className="panel">
              <h3>你现在的感受</h3>
              <label className="slider-label">
                主观疲劳 <strong>{fatigue} / 10</strong>
                <input
                  type="range"
                  min="0"
                  max="10"
                  value={fatigue}
                  onChange={(e) => setFatigue(Number(e.target.value))}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={discomfort}
                  onChange={(e) => {
                    if (e.target.checked) {
                      reportDiscomfort();
                    } else {
                      setDiscomfort(false);
                    }
                  }}
                />
                {discomfortBlocked ? '我已报告不适（本次训练已停止）' : '我有不适，需要停止'}
              </label>
              {discomfortBlocked && (
                <p className="safety-block-note">
                  取消勾选只改变本复选框，不会解除本次训练阻断；本页没有自动开始下一组。
                </p>
              )}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={persist}
                  onChange={(e) => setPersist(e.target.checked)}
                />
                同意在本机保存本次摘要
              </label>
            </section>
          </div>
        </div>
        {tab === 'report' && (
          <div>
            <div className="section-top">
              <div>
                <h2>训练复盘</h2>
                <p>每条调整都能查看依据，计划由你确认。</p>
              </div>
              <button className="secondary" disabled={!report} onClick={exportReport}>
                <Download size={16} />
                导出 JSON
              </button>
            </div>
            {report ? (
              <>
                <div className="stats-grid">
                  <div className="stat">
                    <span>观察覆盖率</span>
                    <strong>
                      {Math.round(report.coverage * 100)}
                      <small>%</small>
                    </strong>
                  </div>
                  <div className="stat">
                    <span>本组完成度</span>
                    <strong>
                      {Math.round(report.completion * 100)}
                      <small>%</small>
                    </strong>
                  </div>
                  <div className="stat">
                    <span>
                      <Flame size={14} />
                      总消耗情景估算
                    </span>
                    <strong>
                      {report.energy.available === false
                        ? '无法估算'
                        : `${report.energy.low_kcal}–${report.energy.high_kcal}`}
                      <small>kcal</small>
                    </strong>
                  </div>
                </div>
                <p className="muted">
                  {report.source === 'simulation'
                    ? '本次为模拟记录。'
                    : report.source === 'video'
                      ? '本次数据来自上传视频。'
                      : '本次来自摄像头记录。'}
                  {report.energy.note}{' '}
                  {report.energy.daily
                    ? `每日维持需求约 ${report.energy.daily.need_kcal} kcal，和本组消耗不是同一个数。 `
                    : ''}
                  {report.energy.net_low_kcal != null
                    ? `本组净消耗 ${report.energy.net_low_kcal}–${report.energy.net_high_kcal} kcal。 `
                    : ''}
                  {report.saved
                    ? '摘要已保存至本机。'
                    : '摘要未写入本机历史（saved=false）。JSON 导出不会写入历史；请在结束本组前勾选“同意在本机保存本次摘要”。'}
                </p>
                {!!report.rep_details?.length && (
                  <section className="panel">
                    <h3>深蹲单次幅度与节奏（最近 100 次）</h3>
                    <p className="muted">
                      下降从角度进入实验区间开始计时；平滑与机位会影响结果。未知不等于动作错误。
                    </p>
                    <div style={{ overflowX: 'auto' }}>
                      <table className="rep-table">
                        <thead>
                          <tr>
                            <th>次数</th>
                            <th>最低膝角</th>
                            <th>下降 / 起身</th>
                            <th>幅度记录</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.rep_details.map((r) => (
                            <tr key={r.number}>
                              <td>{r.number}</td>
                              <td>{r.min_angle_degrees.toFixed(1)}°</td>
                              <td>
                                {r.descent_seconds.toFixed(2)}s / {r.ascent_seconds.toFixed(2)}s
                              </td>
                              <td>
                                {r.rom === 'within_rule'
                                  ? '达到实验阈值'
                                  : r.rom === 'below_rule'
                                    ? '未达到实验阈值'
                                    : '不可评价'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
                <div className="report-grid">
                  <section className="panel">
                    <div className="card-kicker">NEXT SET</div>
                    <h3>{report.proposal.blocked ? '训练已暂停' : '下一组建议'}</h3>
                    <div className="plan-values">
                      <span>
                        <b>{report.proposal.target_reps}</b> 目标次数
                      </span>
                      <span>
                        <b>{report.proposal.rest_seconds}</b> 休息秒数
                      </span>
                    </div>
                    <p>{report.proposal.reason}</p>
                    {discomfortBlocked && !report.proposal.blocked && (
                      <p role="alert" className="safety-block-note">
                        本报告生成于安全锁存之前（历史证据），已失效：不能据此确认/拒绝或继续训练。服务端安全阻断仍然有效。
                      </p>
                    )}
                    {report.proposal.blocked && (
                      <p role="alert" className="safety-block-note">
                        本次报告为不适阻断记录：不会生成或应用下一组建议，也不能通过重复结束或接受提案解除阻断。
                      </p>
                    )}
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        report.proposal.blocked ||
                        report.proposal.status !== 'pending' ||
                        discomfortBlocked ||
                        stateUnknown ||
                        sessionChecking ||
                        storageFault ||
                        sessionUninitialized ||
                        remoteDecision !== null
                      }
                      onClick={accept}
                    >
                      <Check size={16} />
                      {report.proposal.status === 'accepted'
                        ? '已确认并更新目标'
                        : report.proposal.status === 'rejected'
                          ? '已拒绝，保留原计划'
                          : '确认下一组计划'}
                    </button>
                    <button
                      className="secondary"
                      disabled={
                        busy ||
                        report.proposal.blocked ||
                        report.proposal.status !== 'pending' ||
                        discomfortBlocked ||
                        stateUnknown ||
                        sessionChecking ||
                        storageFault ||
                        sessionUninitialized ||
                        remoteDecision !== null
                      }
                      onClick={() => void reject()}
                    >
                      拒绝调整，保持原计划
                    </button>
                    <button
                      className="finish-button"
                      disabled={
                        discomfortBlocked ||
                        stateUnknown ||
                        sessionChecking ||
                        storageFault ||
                        sessionUninitialized
                      }
                      onClick={() => void loadExplanation()}
                    >
                      查看解释
                      <ArrowRight size={16} />
                    </button>
                    {explanation && <p>{explanation}</p>}
                    {report.safety_latched && (
                      <p role="status" className="muted">
                        实时报告以服务端安全状态为准（safety_version {report.safety_version ?? '-'}
                        ）；历史快照不会改写。
                      </p>
                    )}
                  </section>
                  <section className="panel">
                    <h3>教练协作记录</h3>
                    <p className="muted">结构化结果与依据 · 规则节点执行</p>
                    <div className="trace">
                      {report.trace.map((step, i) => (
                        <details key={`${step.role}-${i}`}>
                          <summary>
                            <span className="step-number">{i + 1}</span>
                            <strong>{roleNames[step.role] ?? step.role}</strong>
                            <span className="trace-state">
                              {step.pre_latch
                                ? '锁存前记录（历史）'
                                : step.historical === false
                                  ? '当前安全阻断'
                                  : '完成'}
                            </span>
                          </summary>
                          <p>{step.decision}</p>
                          <pre>{JSON.stringify(step.evidence, null, 2)}</pre>
                        </details>
                      ))}
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <section className="empty">
                <ClipboardList size={35} />
                <h3>完成第一组训练后，复盘会出现在这里。</h3>
                <button className="primary" onClick={() => setTab('training')}>
                  进入训练空间
                </button>
              </section>
            )}
            <section className="panel history">
              <h3>本机历史摘要</h3>
              <div className="inline-actions">
                <button
                  className="secondary"
                  disabled={historyBusy}
                  onClick={() => {
                    void loadSavedHistory();
                  }}
                >
                  {historyBusy ? '读取中…' : '读取已保存记录'}
                </button>
                <button
                  className="secondary danger"
                  onClick={async () => {
                    const hadReport = report !== null;
                    try {
                      await request('/history', { method: 'DELETE' });
                      recorder.current = new LandmarkRecorder();
                      setCaptureLandmarks(false);
                      setHistory([]);
                      setReport(null);
                      setExplanation('');
                      setAnalysisRecovery(null);
                      lastAnalyzeRef.current = null;
                      setRemoteDecision(null);
                      if (hadReport && !discomfortBlockedRef.current) {
                        // The deleted report/proposal must not be accepted or
                        // inherited by a later session, but an accepted target
                        // is the current explicit plan and is intentionally kept.
                        retireSessionStorage();
                        setError(
                          '历史摘要已删除；已删除的报告和提案不再可用。当前训练目标保持不变。',
                        );
                      } else if (runtimeMode === 'backend' && discomfortBlockedRef.current) {
                        // The latch is a separate safety layer and survives the
                        // user history deletion; only the report payload is gone.
                        if (sessionIdRef.current) {
                          void refreshSessionState(sessionIdRef.current);
                        }
                        setError('历史摘要已删除；本次训练的本地安全阻断仍然有效。');
                      } else {
                        setError('历史摘要已删除；当前训练目标和会话保持不变。');
                      }
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  <Trash2 size={15} />
                  删除全部本机摘要
                </button>
                <button
                  className="secondary"
                  disabled={!history.length}
                  onClick={exportHistory}
                >
                  <Download size={15} />
                  导出历史 JSON
                </button>
              </div>
              <p className="muted">
                历史是存档快照，不代表当前可执行计划；当前会话请以复盘页的实时报告和安全状态为准。
              </p>
              {historyStatus ? (
                <p
                  role={historyStatus.kind === 'error' ? 'alert' : 'status'}
                  className={historyStatus.kind === 'error' ? 'alert' : 'muted'}
                >
                  {historyStatus.text}
                </p>
              ) : (
                !history.length && (
                  <p role="status" className="muted">
                    历史尚未加载或为空：请先完成并保存训练，再点击“读取已保存记录”。历史导出与当前报告导出是不同操作。
                  </p>
                )
              )}
              {history.map((r) => (
                <div className="history-row" key={r.session_id}>
                  <span>
                    {r.source === 'simulation' ? '模拟' : r.source === 'video' ? '视频' : '摄像头'}{' '}
                    · {r.session_id.slice(0, 8)}
                    {r.safety_latched || r.proposal.blocked ? ' · 已锁存（历史）' : ' · 历史快照'}
                  </span>
                  <span>
                    完成度 {Math.round(r.completion * 100)}% · {r.proposal.reason}
                  </span>
                </div>
              ))}
            </section>
          </div>
        )}
        {tab === 'nutrition' && (
          <div>
            <div className="section-top">
              <div>
                <h2>一份食物，一次确认</h2>
                <p>直接输入名称或别名，例如「米饭150克」「两个鸡蛋」「宫保鸡丁」。</p>
              </div>
              <span className="badge">示例食品库 · 可搜索匹配</span>
            </div>
            <div className="report-grid">
              <section className="panel">
                <Leaf className="leaf-icon" size={30} />
                <h3>添加食物</h3>
                {foodError && (
                  <p role="alert" className="alert">
                    {foodError}
                  </p>
                )}
                <label className="field-label food-search">
                  食物名称
                  <input
                    value={foodQuery}
                    placeholder="米饭、鸡蛋、宫保鸡丁、香蕉…"
                    onFocus={() => setShowFoodSuggest(true)}
                    onChange={(e) => {
                      const value = e.target.value;
                      setFoodQuery(value);
                      setShowFoodSuggest(true);
                      const local = estimateFoods([{ query: value, grams }]);
                      const hit = local.items[0];
                      if (hit.matched) setGrams(hit.grams);
                    }}
                  />
                  {showFoodSuggest && foodQuery.trim() && (
                    <div className="food-suggest" role="listbox">
                      {searchFoods(foodQuery, 8).map(({ food, score }) => (
                        <button
                          key={food.id}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setFoodQuery(food.name);
                            setGrams(food.unit_g);
                            setShowFoodSuggest(false);
                            void confirmFood(food.name, food.unit_g);
                          }}
                        >
                          <strong>{food.name}</strong>
                          <span>
                            {food.kcal} kcal/100g · {food.group} · 匹配 {score}
                          </span>
                        </button>
                      ))}
                      {searchFoods(foodQuery, 1).length === 0 && (
                        <p>没有直接匹配。可填写下方每 100 克热量后估算。</p>
                      )}
                    </div>
                  )}
                </label>
                <label className="field-label">
                  份量（克）
                  <input
                    type="number"
                    min="1"
                    max="3000"
                    value={grams}
                    onChange={(e) => setGrams(Number(e.target.value))}
                  />
                </label>
                <label className="field-label">
                  自定义热量（kcal / 100g，可选）
                  <input
                    type="number"
                    min="0"
                    max="900"
                    placeholder="未匹配时使用"
                    value={customKcal}
                    onChange={(e) => setCustomKcal(e.target.value)}
                  />
                </label>
                <button className="primary" disabled={foodBusy} onClick={() => void confirmFood()}>
                  {foodBusy ? '正在确认…' : '确认计入'}
                  <ArrowRight size={16} />
                </button>
              </section>
              <section className="panel tinted">
                <h3>记录结果</h3>
                {foodResult || meal.length ? (
                  <>
                    <div className="rep-number">
                      {Math.round(meal.reduce((sum, item) => sum + item.total_kcal, 0) * 10) / 10}
                      <span> kcal</span>
                    </div>
                    <p>{foodResult?.note || '已按示例食物库估算。'}</p>
                  </>
                ) : (
                  <p>输入食物后点「确认计入」，或直接点下拉匹配项。</p>
                )}
                {meal.length > 0 && (
                  <ul className="meal-list">
                    {meal.map((item, index) => (
                      <li key={`${item.name}-${index}`}>
                        <span>
                          {item.name} · {item.grams}g
                        </span>
                        <strong>{item.total_kcal} kcal</strong>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setMeal((prev) => prev.filter((_, i) => i !== index))}
                        >
                          移除
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {meal.length > 0 && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setMealConfirmed(true);
                      setShowFoodSuggest(false);
                    }}
                  >
                    {mealConfirmed ? '本餐已确认' : '确认本餐记录'}
                    <Check size={16} />
                  </button>
                )}
                <p>
                  示例库覆盖主食、蛋白、乳制品、蔬菜、水果、饮品、零食和常见菜肴，按名称与别名匹配。不是营养处方。
                </p>
              </section>
            </div>
          </div>
        )}
        {tab === 'team' && (
          <div>
            <div className="section-top">
              <div>
                <h2>项目协作入口</h2>
                <p>文档、任务与验收标准集中维护。</p>
              </div>
              <a
                className="secondary"
                href="https://github.com/yky666/ai_health_assistant"
                target="_blank"
                rel="noreferrer"
              >
                打开代码仓库
                <ArrowRight size={16} />
              </a>
            </div>
            <div className="bottom-grid">
              {[
                ['产品与分析', 'docs/方案分析.md', '比赛要求、可行性、范围与创新点。'],
                ['架构与接口', 'docs/ARCHITECTURE.md', '模块边界、Agent 流、状态与数据合同。'],
                ['分工与进度', 'docs/TASKS.md', '角色负责人、里程碑与完成定义。'],
              ].map(([title, path, desc]) => (
                <section className="panel" key={title}>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                  <a
                    className="text-link"
                    href={'https://github.com/yky666/ai_health_assistant/blob/main/' + path}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看文档 →
                  </a>
                </section>
              ))}
            </div>
            <section className="panel history">
              <h3>当前交付边界</h3>
              <p>
                已提供：可运行前后端、模拟动作、真实姿态推理接线、原创演示骨架、视频对齐、实验计数、
                会话提案与接受/拒绝、活动/静止/未知分段情景估算，以及仅同源资源模式。
              </p>
              <p>
                待验证：真实动作准确率、活动分段、实际设备性能和断网重启；自动机位与个体校准仍待实现。
                两核心动作优先验收，其余为实验入口。食品数据仍是未完成来源核验的示例。
              </p>
            </section>
          </div>
        )}
        <footer>
          <span>
            <LockKeyhole size={13} /> 默认不保存音视频 · 无云端推理依赖
          </span>
          <span>LocalFit / Open source, personal progress.</span>
        </footer>
      </main>
    </div>
  );
}
