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
  const defaultInput = resolvePath("schema.sql");
  const resolvedInputArg = ddlPathArg || (fs.existsSync(defaultInput) ? "schema.sql" : undefined);

  if (!resolvedInputArg) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const ddlPath = resolvePath(resolvedInputArg);
  const outPath = resolvePath(outPathArg || "config/views.generated.config.json");
  const outputDir = path.dirname(outPath);

  try {
    const ddl = fs.readFileSync(ddlPath, "utf8");
    const config = buildViewsConfigFromSqlServerDdl(ddl, {
      limit: limitArg ? Number(limitArg) : undefined,
      maxSearchFields: maxSearchFieldsArg ? Number(maxSearchFieldsArg) : undefined
    });
    const viewCount = Object.keys(config.views).length;

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(config, null, 2), "utf8");

    if (viewCount === 0) {
      const createTableCount = (ddl.match(/\bCREATE\s+TABLE\b/gi) || []).length;
      console.warn(
        `Generated 0 view(s) into ${outPath}. Found ${createTableCount} CREATE TABLE statement(s).`
      );
      console.warn(
        "If this is unexpected, verify the DDL contains SQL Server CREATE TABLE definitions."
      );
      return;
    }

    console.log(`Generated ${viewCount} view(s) into ${outPath}`);
  } catch (error) {
    console.error(`Failed to generate views config: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
