export function formatPartialCnic(val: string): string {
  const n = val.replace(/\D/g, '');
  if (!n) return val;
  if (n.length <= 5) return n;
  if (n.length <= 12) return `${n.slice(0, 5)}-${n.slice(5)}`;
  return `${n.slice(0, 5)}-${n.slice(5, 12)}-${n.slice(12, 13)}`;
}
