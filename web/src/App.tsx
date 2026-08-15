import { useCallback, useEffect, useState } from "react";
import { auth, type AuthResult, type Profile, ApiError } from "./api/client";
import { acceptTos } from "./api/deals";
import { DealsScreen } from "./screens/DealsScreen";
import { CalendarScreen } from "./screens/CalendarScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { DealScreen } from "./screens/DealScreen";
import { NewDealScreen } from "./screens/NewDealScreen";
import { Loader } from "./components/Loader";
import { tg } from "./lib/telegram";

type Route =
  | { name: "deals" }
  | { name: "calendar" }
  | { name: "profile" }
  | { name: "deal"; dealId: string }
  | { name: "new" };

// Р-13: навигация без иконок — только подписи, активный раздел выделен цветом.
const TABS = [
  { name: "deals", label: "Записи" },
  { name: "calendar", label: "Календарь" },
  { name: "profile", label: "Профиль" },
] as const;

export function App() {
  const [session, setSession] = useState<AuthResult | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>({ name: "deals" });
  const [tosAccepted, setTosAccepted] = useState(false);

  useEffect(() => {
    auth()
      .then((result) => {
        setSession(result);
        setProfile(result.profiles.find((p) => p.is_default) ?? result.profiles[0] ?? null);
        setTosAccepted(result.user.tos_accepted);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Не удалось подключиться"));
  }, []);

  // Аппаратная кнопка «назад» ведёт себя как в родных приложениях Telegram.
  useEffect(() => {
    const app = tg;
    if (!app) return;

    const isNested = route.name === "deal" || route.name === "new";
    const goBack = () => setRoute({ name: "deals" });

    if (isNested) {
      app.BackButton.show();
      app.BackButton.onClick(goBack);
      return () => {
        app.BackButton.offClick(goBack);
        app.BackButton.hide();
      };
    }
    app.BackButton.hide();
  }, [route.name]);

  const openDeal = useCallback((dealId: string) => setRoute({ name: "deal", dealId }), []);
  const back = useCallback(() => setRoute({ name: "deals" }), []);

  if (error) {
    return (
      <div className="screen center">
        <div className="empty">
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!session || !profile) return <Loader />;

  // FR-003: без принятой оферты внутрь не пускаем.
  if (!tosAccepted) {
    return (
      <div className="screen center">
        <div className="card tos">
          <h1>Мост долгов</h1>
          <p>
            Приложение фиксирует договорённости об оплате между поставщиком и магазином.
            Запись действует, только когда её подтвердили обе стороны.
          </p>
          <p className="hint">
            Продолжая, вы принимаете пользовательское соглашение и политику
            конфиденциальности. Мы не собираем телефон, ФИО и другие персональные данные —
            только то, что передаёт Telegram.
          </p>
          <button
            className="filled"
            onClick={async () => {
              await acceptTos();
              setTosAccepted(true);
            }}
          >
            Принять и начать
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {route.name === "deals" && (
        <DealsScreen profile={profile} onOpen={openDeal} onCreate={() => setRoute({ name: "new" })} />
      )}
      {route.name === "calendar" && <CalendarScreen profile={profile} onOpen={openDeal} />}
      {route.name === "profile" && (
        <ProfileScreen
          session={session}
          profile={profile}
          onSelectProfile={setProfile}
        />
      )}
      {route.name === "deal" && (
        <DealScreen dealId={route.dealId} profile={profile} onBack={back} />
      )}
      {route.name === "new" && <NewDealScreen profile={profile} onDone={back} onCancel={back} />}

      {route.name !== "deal" && route.name !== "new" && (
        <nav className="tabbar">
          {TABS.map((tab) => (
            <button
              key={tab.name}
              className={route.name === tab.name ? "tab active" : "tab"}
              onClick={() => setRoute({ name: tab.name } as Route)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
