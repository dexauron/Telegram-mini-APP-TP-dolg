/**
 * Выпуск JWT для клиента (Р-11).
 *
 * Supabase проверяет подпись этим же секретом, поэтому RLS и Realtime работают
 * штатно: в claim `sub` лежит app.users.id, на который смотрят политики.
 * Токен короткоживущий — Mini App обновляет его через функцию auth.
 */

const encoder = new TextEncoder();

function base64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface UserClaims {
  sub: string;
  telegram_id: number;
  /** Профили пользователя — чтобы клиент не ходил за ними отдельным запросом. */
  profile_ids?: string[];
}

export async function signUserToken(
  claims: UserClaims,
  secret: string,
  ttlSeconds = 60 * 60,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...claims,
    // PostgREST выбирает роль по этому claim: authenticated подпадает под RLS.
    role: "authenticated",
    aud: "authenticated",
    iat: now,
    exp: now + ttlSeconds,
  };

  const head = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${head}.${body}`));

  return `${head}.${body}.${base64url(new Uint8Array(signature))}`;
}
