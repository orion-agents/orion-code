import { createStopDecision, type StopDecision } from '../framework/stop-decision';
import type { CompletionGateResult, ProgressDelta } from './types';

export interface StopControllerOptions {
  noProgressThreshold?: number;
}

/**
 * Harness-owned completion boundary. It never converts a missing receipt or
 * repeated state into task completion; callers may continue or persist a pause.
 */
export class StopController {
  private readonly noProgressThreshold: number;

  constructor(options: StopControllerOptions = {}) {
    this.noProgressThreshold = Math.max(2, Math.floor(options.noProgressThreshold ?? 3));
  }

  decideCompletion(gate: CompletionGateResult, progress: ProgressDelta): StopDecision {
    const criterionStates = (gate.criterionResults ?? []).map(item => ({
      id: item.criterionId,
      status: item.status,
    }));
    const evidenceRefs = [
      ...new Set((gate.criterionResults ?? []).flatMap(item => item.evidenceRefs)),
    ];
    if (gate.canComplete) {
      return createStopDecision({
        scope: 'request',
        status: 'completed',
        disposition: 'finish_scope',
        reason: { code: 'criteria_satisfied', message: 'All applicable criteria are satisfied.' },
        evidence: evidenceRefs.map(ref => ({
          kind: 'verification',
          source: ref,
          detail: 'Bound criterion evidence',
        })),
        nextActions: [],
        resources: {},
        criterionStates,
        progressDelta: progress,
        evidenceRefs,
        resumable: false,
      });
    }

    const noProgress = progress.repeatedSignatureCount >= this.noProgressThreshold;
    return createStopDecision({
      scope: 'request',
      status: 'stopped',
      disposition: noProgress ? 'pause_scope' : 'resume_allowed',
      reason: {
        code: noProgress ? 'no_progress' : 'completion_gate',
        message: noProgress
          ? `No observable progress for ${progress.repeatedSignatureCount} repeated completion states.`
          : gate.missing.join('; ') || 'Required criterion evidence is missing.',
      },
      evidence: evidenceRefs.map(ref => ({
        kind: 'verification',
        source: ref,
        detail: 'Bound criterion evidence',
      })),
      nextActions: noProgress
        ? [
            {
              kind: 'inspect',
              label: 'Inspect missing criterion evidence',
              command: '/harness explain',
            },
            { kind: 'change_input', label: 'Choose a different verification strategy' },
            { kind: 'resume', label: 'Resume after changing the strategy', command: '继续' },
          ]
        : [
            {
              kind: 'continue',
              label: 'Run the missing verification and continue',
              command: '继续',
            },
            {
              kind: 'inspect',
              label: 'Inspect missing criterion evidence',
              command: '/harness explain',
            },
          ],
      resources: {},
      criterionStates,
      progressDelta: progress,
      evidenceRefs,
      resumable: true,
    });
  }
}
