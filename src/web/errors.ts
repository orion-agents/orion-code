export class WebWorkbenchError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = status === 409 ? 'request_conflict' : 'web_workbench_error'
  ) {
    super(message);
    this.name = 'WebWorkbenchError';
  }
}
