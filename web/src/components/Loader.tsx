export function Loader({ text = "Загрузка…" }: { text?: string }) {
  return <div className="loader">{text}</div>;
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

/** Сгруппированный блок в стиле Settings: заголовок, карточка, пояснение снизу. */
export function Group({
  title, footer, padded, children,
}: {
  title?: string;
  footer?: string;
  padded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="group">
      {title && <h2 className="group-title">{title}</h2>}
      <div className={padded ? "card padded" : "card"}>{children}</div>
      {footer && <p className="group-footer">{footer}</p>}
    </section>
  );
}
