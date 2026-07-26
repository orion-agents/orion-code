export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${formatNumber(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${formatNumber(mb)} MB`;
  return `${formatNumber(mb / 1024)} GB`;
}

function formatNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}
