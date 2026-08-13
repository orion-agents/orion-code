import type { GoalRuntimeEvent } from './types';

function completionDetails(event: Extract<GoalRuntimeEvent, { type: 'goal_completed' }>): string {
  const criterionResults = event.audit.criterionResults ?? [];
  const criteria = criterionResults.length
    ? criterionResults
        .map(result => {
          const refs = result.evidenceRefs.length
            ? `[${result.evidenceRefs.join(',')}]`
            : '[no-evidence]';
          return `${result.criterionId}=${result.status}${refs}`;
        })
        .join(', ')
    : event.audit.passed
      ? 'all=passed'
      : 'unavailable';
  const evidenceIds = [
    ...new Set([
      ...event.audit.evidenceRefs,
      ...criterionResults.flatMap(result => result.evidenceRefs),
    ]),
  ];
  const provenance = (event.audit.finalSummary?.criterionResults ?? [])
    .flatMap(result =>
      (result.evidence ?? []).map(
        evidence =>
          `${result.criterionId}:${evidence.evidenceId}=${evidence.provenance}/${evidence.kind}`
      )
    )
    .join(',');
  return `criteria ${criteria} | evidence ${evidenceIds.length ? evidenceIds.join(',') : 'none'}${provenance ? ` | provenance ${provenance}` : ''}`;
}

/** Renderer-neutral, deterministic one-line projection for a Goal runtime event. */
export function formatGoalRuntimeEvent(event: GoalRuntimeEvent): string {
  switch (event.type) {
    case 'goal_restored':
      return `Goal restored ${event.goal.status}: ${event.goal.objective}`;
    case 'goal_updated':
      return `Goal ${event.goal.status}: ${event.goal.objective}`;
    case 'goal_completed':
      return `Goal complete: ${event.goal.objective} | ${completionDetails(event)}`;
    case 'goal_audit_failed':
      return `Goal audit failed (${event.audit}): ${event.summary}`;
    case 'goal_plan_updated':
      return `Goal plan r${event.planRevision} ${event.phase}${event.nextAction ? ` | next: ${event.nextAction}` : ''}`;
    case 'goal_continuation':
      return `Goal continuation ${event.phase}: ${event.reason}`;
    case 'goal_evidence_recorded':
      return `Goal evidence ${event.evidence.result} [${event.evidence.id}] ${event.evidence.kind}: ${event.evidence.subject}`;
    case 'goal_cleared':
      if (
        event.reason === 'completion_auto_exit' ||
        event.reason === 'completion_recovery_auto_exit'
      ) {
        return `Goal complete · exited Goal mode: ${event.goalId}`;
      }
      return `Goal cleared: ${event.goalId}`;
  }
}
