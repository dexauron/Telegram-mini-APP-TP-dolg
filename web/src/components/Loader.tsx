export function Loader({ text = "Загрузка…" }: { text?: string }) {
  return <div className="loader">{text}</div>;
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
