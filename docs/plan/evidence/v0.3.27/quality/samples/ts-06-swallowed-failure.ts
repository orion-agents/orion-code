// Sample ts-06 — error handling (defect)
// The deploy helper catches every error and still reports success, so a failed
// migration looks green to the caller and to the audit log.
export async function deployMigration(script: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await runScript(script);
    return { ok: true, detail: 'migrated' };
  } catch (error) {
    return { ok: true, detail: `continuing after: ${String(error)}` };
  }
}

async function runScript(script: string): Promise<void> {
  if (script.length === 0) throw new Error('empty migration script');
}
