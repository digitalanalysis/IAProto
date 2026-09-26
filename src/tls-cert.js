const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const RENEW_BEFORE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function isUsableCertificate(certPem) {
  try {
    const certificate = new crypto.X509Certificate(certPem);
    return new Date(certificate.validTo).getTime() - Date.now() > RENEW_BEFORE_EXPIRY_MS;
  } catch {
    return false;
  }
}

function collectAltNames() {
  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    { type: 7, ip: "::1" }
  ];
  const hostname = os.hostname();
  if (hostname && hostname.toLowerCase() !== "localhost") {
    altNames.push({ type: 2, value: hostname });
  }
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (!address.internal && address.family === "IPv4") {
        altNames.push({ type: 7, ip: address.address });
      }
    }
  }
  return altNames;
}

async function generateSelfSignedCertificate() {
  const selfsigned = require("selfsigned");
  const result = await selfsigned.generate([{ name: "commonName", value: os.hostname() || "localhost" }], {
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: collectAltNames() }
    ]
  });
  return { key: result.private, cert: result.cert };
}

// Returns { key, cert, source } for the HTTPS listener.
// Uses configured certificate files when provided, otherwise a self-signed
// certificate cached in certDir (regenerated when missing or close to expiry).
async function loadTlsCredentials({ certDir, certFile = "", keyFile = "" }) {
  if (certFile && keyFile) {
    return {
      cert: fs.readFileSync(certFile, "utf8"),
      key: fs.readFileSync(keyFile, "utf8"),
      source: certFile
    };
  }

  const cachedCertPath = path.join(certDir, "self-signed.crt");
  const cachedKeyPath = path.join(certDir, "self-signed.key");
  if (fs.existsSync(cachedCertPath) && fs.existsSync(cachedKeyPath)) {
    const cert = fs.readFileSync(cachedCertPath, "utf8");
    if (isUsableCertificate(cert)) {
      return { cert, key: fs.readFileSync(cachedKeyPath, "utf8"), source: cachedCertPath };
    }
  }

  const generated = await generateSelfSignedCertificate();
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(cachedKeyPath, generated.key, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(cachedCertPath, generated.cert, "utf8");
  return { ...generated, source: `${cachedCertPath} (newly generated)` };
}

module.exports = { loadTlsCredentials };
