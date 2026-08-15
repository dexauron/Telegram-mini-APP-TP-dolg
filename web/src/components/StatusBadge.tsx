import { statusMeta } from "../lib/format";

/**
 * Р-13: статус обозначается цветом и словом, без эмодзи. Заливка берётся из
 * того же цвета с прозрачностью, как в родных элементах iOS.
 */
export function StatusBadge({ status, isOverdue }: { status: string; isOverdue: boolean }) {
  const meta = statusMeta(status, isOverdue);
  return (
    <span className="badge" style={{ color: meta.color, background: `${meta.color}1f` }}>
      {meta.label}
    </span>
  );
}
