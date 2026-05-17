export type TimelinePoint = {
  t: number;
  v: number;
  kind?: 'pos' | 'ctrl';
};

export type TimelineKeyframe = {
  t: number;
  value: unknown;
  leftSmooth?: number;
  rightSmooth?: number;
};

export type TimelineCurveLane = {
  key: string;
  type?: 'curve';
  enabled: boolean;
  points: TimelinePoint[];
  seq?: number;
  renderPoints?: TimelinePoint[];
  renderSeq?: number;
};

export type TimelineStepLane = {
  key: string;
  type: 'step';
  enabled: boolean;
  points: TimelinePoint[];
  seq?: number;
  renderPoints?: TimelinePoint[];
  renderSeq?: number;
};

export type TimelineTrigger = {
  on: {
    t: number;
    value: number;
  };
  off: {
    t: number;
  };
};

export type TimelineTriggerLane = {
  key: string;
  type: 'trigger';
  enabled: boolean;
  triggers: TimelineTrigger[];
  seq?: number;
  renderTriggers?: TimelineTrigger[];
  renderSeq?: number;
};

export type TimelineKeyframeLane = {
  key: string;
  type: 'keyframes';
  enabled: boolean;
  keyframes: TimelineKeyframe[];
  seq?: number;
  renderKeyframes?: TimelineKeyframe[];
  renderSeq?: number;
};

export type TimelineEventPoint = {
  t: number;
};

export type TimelineEventLane = {
  key: string;
  type: 'event';
  enabled: boolean;
  events: TimelineEventPoint[];
  seq?: number;
  renderEvents?: TimelineEventPoint[];
  renderSeq?: number;
};

export type TimelineLane =
  | TimelineCurveLane
  | TimelineStepLane
  | TimelineTriggerLane
  | TimelineKeyframeLane
  | TimelineEventLane;

export type TimelineControl = {
  path: string[];
  enabled: boolean;
  manualOverride: boolean;
  lanes: TimelineLane[];
};

export type TimelineStateKind = 'playing' | 'paused' | 'scrubbing' | 'rendering';

export type TimelineState = {
  time: number;
  state: TimelineStateKind;
  playing: boolean;
  alwaysRender: boolean;
  loopEnabled: boolean;
  loopDurationSec: number;
  controls: TimelineControl[];
};
