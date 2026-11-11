import { generateKeyPairSync } from "node:crypto";

/**
 * Generate ONCE, and copy these values to Cloudflare secrets.
 * Never commit the generated private key to GitHub or send it in chat.
 */
const pair=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
const pub=pair.publicKey.export({format:"jwk"});
const priv=pair.privateKey.export({format:"jwk"});
const key=Buffer.concat([Buffer.from([4]),Buffer.from(pub.x,"base64url"),Buffer.from(pub.y,"base64url")]).toString("base64url");
console.log("VAPID_PUBLIC_KEY="+key);
console.log("VAPID_PRIVATE_KEY="+priv.d);
console.log("VAPID_SUBJECT=mailto:email@dominio.it");
console.log("\nStore the private key ONLY as a Cloudflare secret; keep the pair stable across deploys.");
