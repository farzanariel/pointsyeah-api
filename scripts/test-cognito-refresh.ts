// One-shot probe: does Cognito's REFRESH_TOKEN_AUTH flow work with our creds?
// Reads POINTSYEAH_COGNITO_* from .env. Prints the new idToken's exp + decodes
// a few claims so we can sanity-check it matches our existing token's user.
process.loadEnvFile(".env");

const region = process.env.POINTSYEAH_COGNITO_REGION;
const clientId = process.env.POINTSYEAH_COGNITO_CLIENT_ID;
const refreshToken = process.env.POINTSYEAH_COGNITO_REFRESH_TOKEN;
if (!region || !clientId || !refreshToken) {
  console.error("Missing POINTSYEAH_COGNITO_REGION / CLIENT_ID / REFRESH_TOKEN in .env");
  process.exit(1);
}

const t0 = Date.now();
const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-amz-json-1.1",
    "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
  },
  body: JSON.stringify({
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: clientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  }),
});

const elapsed = Date.now() - t0;
const text = await res.text();
console.log(`status=${res.status}  elapsed=${elapsed}ms`);
if (!res.ok) {
  console.error("Body:", text.slice(0, 1000));
  process.exit(1);
}

const json = JSON.parse(text) as {
  AuthenticationResult?: {
    IdToken: string;
    AccessToken: string;
    ExpiresIn: number;
    TokenType: string;
  };
};
const idToken = json.AuthenticationResult?.IdToken;
if (!idToken) {
  console.error("No IdToken in response. Full body:", text.slice(0, 1000));
  process.exit(1);
}

function decode(jwt: string): Record<string, unknown> {
  const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"));
}

const payload = decode(idToken);
const exp = payload.exp as number;
const now = Math.floor(Date.now() / 1000);

console.log(`\n✓ Got fresh idToken (${idToken.length} chars)`);
console.log(`  email:    ${payload.email}`);
console.log(`  username: ${payload["cognito:username"]}`);
console.log(`  aud:      ${payload.aud}`);
console.log(`  exp:      ${new Date(exp * 1000).toISOString()} (in ${exp - now}s)`);
console.log(`  ExpiresIn from response: ${json.AuthenticationResult?.ExpiresIn}s`);
