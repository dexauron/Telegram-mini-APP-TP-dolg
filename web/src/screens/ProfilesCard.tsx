import { useState } from "react";
import type { Profile } from "../api/client";
import {
  createProfile, setDefaultProfile, archiveProfile, updateProfile, KIND_LABEL,
} from "../api/profiles";
import { Group } from "../components/Loader";
import { confirm, haptic } from "../lib/telegram";

const KINDS: Array<Profile["kind"]> = ["supplier", "store", "both"];

/**
 * FR-008…FR-012: несколько профилей на один аккаунт Telegram. Записи привязаны
 * к профилю, поэтому переключение здесь меняет и списки, и календарь, и отчёты.
 */
export function ProfilesCard({
  profiles, active, onSelect, onChanged,
}: {
  profiles: Profile[];
  active: Profile;
  onSelect: (profile: Profile) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Profile["kind"]>("both");
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      haptic("success");
      setAdding(false);
      setEditing(null);
      setName("");
      onChanged();
    } catch (e) {
      haptic("error");
      alert(e instanceof Error ? e.message : "Не получилось");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group
      title={profiles.length > 1 ? "Профили" : "Профиль"}
      footer="Профиль — это ваша сторона в записях: точка, склад или юрлицо. Записи одного профиля не смешиваются с записями другого."
    >
      {profiles.map((p) => (
        <div key={p.id}>
          <button
            className="cell"
            onClick={() => (p.id === active.id ? setEditing(editing === p.id ? null : p.id) : onSelect(p))}
          >
            <span className="cell-main">
              <span className={p.id === active.id ? "cell-title strong" : "cell-title"}>
                {p.name}
              </span>
              <span className="cell-sub">
                {KIND_LABEL[p.kind]}
                {p.is_default ? " · основной" : ""}
              </span>
            </span>
            <span className="cell-right">
              <span className="cell-value">
                {p.id === active.id ? "Активен" : "Выбрать"}
              </span>
              <span className="chevron">›</span>
            </span>
          </button>

          {editing === p.id && (
            <div className="form">
              <div className="field">
                <label>Название</label>
                <input
                  value={name || p.name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={p.name}
                />
              </div>
              <div className="card padded" style={{ margin: 0, borderRadius: 0 }}>
                <div className="segmented">
                  {KINDS.map((k) => (
                    <button
                      key={k}
                      className={(name ? kind : p.kind) === k ? "segment active" : "segment"}
                      onClick={() => setKind(k)}
                    >
                      {k === "supplier" ? "Поставщик" : k === "store" ? "Магазин" : "Оба"}
                    </button>
                  ))}
                </div>
                <div className="actions">
                  <button
                    className="filled"
                    disabled={busy}
                    onClick={() => run(() => updateProfile(p.id, name || p.name, kind))}
                  >
                    Сохранить
                  </button>
                  {!p.is_default && (
                    <button
                      className="tinted"
                      disabled={busy}
                      onClick={() => run(() => setDefaultProfile(p.id))}
                    >
                      Сделать основным
                    </button>
                  )}
                </div>
                {!p.is_default && (
                  <button
                    className="plain destructive"
                    disabled={busy}
                    onClick={async () => {
                      if (await confirm(`Убрать профиль «${p.name}»? Закрытые записи по нему останутся.`)) {
                        void run(() => archiveProfile(p.id));
                      }
                    }}
                  >
                    Убрать профиль
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      ))}

      {adding ? (
        <div className="form">
          <div className="field">
            <label>Название</label>
            <input
              autoFocus
              placeholder="Магазин на Ленина"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="card padded" style={{ margin: 0, borderRadius: 0 }}>
            <div className="segmented">
              {KINDS.map((k) => (
                <button
                  key={k}
                  className={kind === k ? "segment active" : "segment"}
                  onClick={() => setKind(k)}
                >
                  {k === "supplier" ? "Поставщик" : k === "store" ? "Магазин" : "Оба"}
                </button>
              ))}
            </div>
            <div className="actions">
              <button
                className="filled"
                disabled={busy || !name.trim()}
                onClick={() => run(() => createProfile(name.trim(), kind))}
              >
                Создать
              </button>
              <button className="tinted" onClick={() => { setAdding(false); setName(""); }}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button className="plain" onClick={() => { setAdding(true); setName(""); setKind("both"); }}>
          Добавить профиль
        </button>
      )}
    </Group>
  );
}
