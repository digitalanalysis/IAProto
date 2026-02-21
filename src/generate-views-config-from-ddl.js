const fs = require("fs");
const path = require("path");
const { buildViewsConfigFromSqlServerDdl } = require("./utils/buildViewsConfigFromSqlServerDdl");

function printUsage() {
  console.error(
    "Usage: node src/generate-views-config-from-ddl.js <input.ddl.sql> [output.json] [limit] [maxSearchFields]"
  );
}

function resolvePath(filePath) {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(process.cwd(), filePath);
}

function main() {
  const [, , ddlPathArg, outPathArg, limitArg, maxSearchFieldsArg] = process.argv;

  if (!ddlPathArg) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const ddlPath = resolvePath(ddlPathArg);
  const outPath = resolvePath(outPathArg || "config/views.generated.config.json");

  const ddl = fs.readFileSync(ddlPath, "utf8");
  const config = buildViewsConfigFromSqlServerDdl(ddl, {
    limit: limitArg ? Number(limitArg) : undefined,
    maxSearchFields: maxSearchFieldsArg ? Number(maxSearchFieldsArg) : undefined
  });

  fs.writeFileSync(outPath, JSON.stringify(config, null, 2), "utf8");
  console.log(`Generated ${Object.keys(config.views).length} view(s) into ${outPath}`);
}

main();
