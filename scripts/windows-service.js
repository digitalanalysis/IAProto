// Installs or removes the app as a Windows service using node-windows.
// Run from an administrator prompt:
//   npm run service:install     (optional: set PORT / HOST first to override the defaults)
//   npm run service:uninstall
const path = require("path");
const { Service } = require("node-windows");

const projectRoot = path.join(__dirname, "..");
const action = process.argv[2];

const env = [{ name: "PORT", value: process.env.PORT || "3000" }];
if (process.env.HOST) {
  env.push({ name: "HOST", value: process.env.HOST });
}

const svc = new Service({
  name: "DCOM Data Explorer",
  description: "DCOM Data Explorer web app (Node.js)",
  script: path.join(projectRoot, "src", "server.js"),
  workingDirectory: projectRoot,
  env
});

// Keep the service wrapper and its logs in <project>/daemon rather than src/daemon.
svc.directory(projectRoot);

svc.on("error", (error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});

if (action === "install") {
  svc.on("install", () => {
    console.log(`Installed "${svc.name}". Starting...`);
    svc.start();
  });
  svc.on("start", () => {
    console.log(`Service started on port ${env[0].value}. Logs: ${svc.root}`);
  });
  svc.on("invalidinstallation", () => {
    console.error(`Installation of "${svc.name}" is incomplete. Run "npm run service:uninstall", then install again.`);
    process.exitCode = 1;
  });
  svc.on("alreadyinstalled", () => {
    console.log(`"${svc.name}" is already installed. Run "npm run service:uninstall" first to reinstall.`);
  });
  svc.install();
} else if (action === "uninstall") {
  svc.on("uninstall", () => {
    console.log(`Removed "${svc.name}".`);
  });
  svc.on("alreadyuninstalled", () => {
    console.log(`"${svc.name}" is not installed.`);
  });
  svc.uninstall();
} else {
  console.log("Usage: node scripts/windows-service.js install|uninstall");
  process.exitCode = 1;
}
