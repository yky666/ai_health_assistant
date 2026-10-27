export type { Exercise } from './catalog';
export type SourceMode = 'simulation' | 'camera' | 'video';
export type Point = { x: number; y: number; z?: number; visibility?: number };
export type SquatRep = {
  number: number;
  start_seconds: number;
  bottom_seconds: number;
  end_seconds: number;
  descent_seconds: number;
  ascent_seconds: number;
  min_angle_degrees: number;
  rom: 'within_rule' | 'below_rule' | 'unobservable';
};
export type Metrics = {
  reps: number;
  phase: string;
  quality: boolean;
  quality_status?: 'observed' | 'unknown';
  quality_code?: string;
  unknown_reason?: string;
  hint: string;
  angle: number;
  events: number;
  squatReps: SquatRep[];
};
export type Report = {
  schema_version?: string;
  policy_version?: string;
  session_id: string;
  input_version: number;
  source: string;
  coverage: number;
  completion: number;
  saved: boolean;
  rep_details: SquatRep[];
  energy: {
    low_kcal: number;
    high_kcal: number;
    net_low_kcal?: number;
    net_high_kcal?: number;
    work_seconds?: number;
    rest_seconds?: number;
    unknown_seconds?: number;
    available?: boolean;
    daily?: { bmr_kcal: number; tdee_kcal: number; need_kcal: number; note: string };
    note: string;
  };
  proposal: {
    target_reps: number;
    rest_seconds: number;
    reason: string;
    blocked: boolean;
    status: string;
    proposal_id?: string;
    decided_at?: string | null;
  };
  trace: {
    role: string;
    runtime: string;
    decision: string;
    evidence: Record<string, unknown>;
    timestamp: string;
    pre_latch?: boolean;
    historical?: boolean;
  }[];
  // Backend-mode safety metadata. Browser-mode reports do not have it.
  safety_latched?: boolean;
  safety_version?: number;
};

export type SessionState = {
  session_id: string;
  status: 'active' | 'expired';
  safety_latched: boolean;
  safety_version: number;
  input_version: number | null;
  proposal_id: string | null;
  proposal_status: string | null;
  decided_at: string | null;
  persist_history: boolean;
  report_recoverable: boolean;
  expires_at: string;
};

export type SafetyEventReceipt = {
  session_id: string;
  event_id: string;
  event_type: string;
  safety_latched: boolean;
  safety_version: number;
  status: string;
  duplicate: boolean;
};

export type ExplanationResponse = {
  text: string;
  runtime: string;
  input_version: number;
  safety_latched?: boolean;
  safety_version?: number;
  blocked?: boolean;
};
