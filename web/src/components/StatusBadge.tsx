import { statusMeta } from "../lib/format";

export function StatusBadge({ status, isOverdue }: { status: string; isOverdue: boolean }) {
  const meta = statusMeta(status, isOverdue);
  return (
    <span className="badge" style={{ color: meta.color, borderColor: meta.color }}>
      {meta.label}
    </span>
  );
}
