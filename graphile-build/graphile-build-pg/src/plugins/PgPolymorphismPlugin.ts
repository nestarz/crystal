import "graphile-config";
import "./PgCodecsPlugin.js";
import "./PgProceduresPlugin.js";
import "./PgRelationsPlugin.js";
import "./PgTablesPlugin.js";

import type {
  PgTypeCodec,
  PgTypeCodecPolymorphism,
  PgTypeCodecPolymorphismRelational,
  PgTypeCodecPolymorphismSingle,
  PgTypeCodecPolymorphismSingleTypeColumnSpec,
} from "@dataplan/pg";

import { version } from "../index.js";
import {
  parseDatabaseIdentifierFromSmartTag,
  parseSmartTagsOptsString,
} from "../utils.js";
import { getBehavior } from "../behavior.js";
import { ExecutableStep } from "grafast";
import {
  GraphQLInterfaceType,
  GraphQLNamedType,
  isInterfaceType,
} from "graphql";

declare global {
  namespace GraphileConfig {
    interface GatherHelpers {
      pgPolymorphism: Record<string, never>;
    }
  }
  namespace GraphileBuild {
    interface ScopeInterface {
      pgCodec?: PgTypeCodec<any, any, any, any>;
      isPgPolymorphicTableType?: boolean;
      pgPolymorphism?: PgTypeCodecPolymorphism<string>;
    }
    interface ScopeObject {
      pgPolymorphism?: PgTypeCodecPolymorphism<string>;
      pgPolymorphicSingleTableType?: {
        typeIdentifier: string;
        name: string;
        columns: ReadonlyArray<
          PgTypeCodecPolymorphismSingleTypeColumnSpec<any>
        >;
      };
    }
  }
}

function parseColumn(
  colSpec: string,
): PgTypeCodecPolymorphismSingleTypeColumnSpec<any> {
  let spec = colSpec;
  let isNotNull = false;
  if (spec.endsWith("!")) {
    spec = spec.substring(0, spec.length - 1);
    isNotNull = true;
  }
  const [a, b] = spec.split(">");
  return {
    column: a,
    isNotNull,
    rename: b,
  };
}

export const PgPolymorphismPlugin: GraphileConfig.Plugin = {
  name: "PgPolymorphismPlugin",
  description: "Adds polymorphism",
  version,
  after: ["PgSmartCommentsPlugin", "PgV4SmartTagsPlugin"],
  gather: {
    namespace: "pgPolymorphism",
    helpers: {},
    hooks: {
      async pgCodecs_recordType_extensions(info, event) {
        const { pgClass, extensions, databaseName } = event;
        const interfaceTag =
          extensions.tags.interface ??
          pgClass.getTagsAndDescription().tags.interface;
        if (interfaceTag) {
          if (typeof interfaceTag !== "string") {
            throw new Error(
              "Invalid 'interface' smart tag; string expected. Did you add too many?",
            );
          }
          const { params } = parseSmartTagsOptsString<"type" | "mode" | "name">(
            interfaceTag,
            0,
          );
          switch (params.mode) {
            case "single": {
              const { type = "type" } = params;
              const attr = pgClass.getAttribute({ name: type });
              if (!attr) {
                throw new Error(
                  `Invalid '@interface' smart tag - there is no '${type}' column on ${
                    pgClass.getNamespace()!.nspname
                  }.${pgClass.relname}`,
                );
              }

              const rawTypeTags = extensions.tags.type;
              const typeTags = Array.isArray(rawTypeTags)
                ? rawTypeTags.map((t) => String(t))
                : [String(rawTypeTags)];

              const attributeNames = pgClass
                .getAttributes()
                .filter((a) => a.attnum >= 1)
                .map((a) => a.attname);

              const types: PgTypeCodecPolymorphismSingle<any>["types"] =
                Object.create(null);
              const specificColumns = new Set<string>();
              for (const typeTag of typeTags) {
                const {
                  args: [typeValue],
                  params: { name, columns },
                } = parseSmartTagsOptsString<"name" | "columns">(typeTag, 1);
                if (!name) {
                  throw new Error(`Every type must have a name`);
                }
                types[typeValue] = {
                  name,
                  columns: columns?.split(",").map(parseColumn) ?? [],
                };
                for (const col of types[typeValue].columns) {
                  specificColumns.add(col.column);
                }
              }

              const commonColumns = attributeNames.filter(
                (n) => !specificColumns.has(n),
              );
              extensions.polymorphism = {
                mode: "single",
                commonColumns,
                typeColumns: [type],
                types,
              };
              break;
            }
            case "relational": {
              const { type = "type" } = params;
              const attr = pgClass.getAttribute({ name: type });
              if (!attr) {
                throw new Error(
                  `Invalid '@interface' smart tag - there is no '${type}' column on ${
                    pgClass.getNamespace()!.nspname
                  }.${pgClass.relname}`,
                );
              }

              const rawTypeTags = extensions.tags.type;
              const typeTags = Array.isArray(rawTypeTags)
                ? rawTypeTags.map((t) => String(t))
                : [String(rawTypeTags)];

              const types: PgTypeCodecPolymorphismRelational<any>["types"] =
                Object.create(null);
              for (const typeTag of typeTags) {
                const {
                  args: [typeValue],
                  params: { references },
                } = parseSmartTagsOptsString<"references">(typeTag, 1);
                if (!references) {
                  throw new Error(
                    `@type of an @interface(mode:relational) must have a 'references:' parameter`,
                  );
                }
                const [namespaceName, tableName] =
                  parseDatabaseIdentifierFromSmartTag(
                    references,
                    2,
                    pgClass.getNamespace()?.nspname,
                  );
                const referencedClass =
                  await info.helpers.pgIntrospection.getClassByName(
                    databaseName,
                    namespaceName,
                    tableName,
                  );
                if (!referencedClass) {
                  throw new Error(
                    `Could not find referenced class '${namespaceName}.${tableName}'`,
                  );
                }
                types[typeValue] = {
                  references: info.inflection.tableSourceName({
                    databaseName,
                    pgClass: referencedClass,
                  }),
                };
              }

              extensions.polymorphism = {
                mode: "relational",
                typeColumns: [type],
                types,
              };
              break;
            }
            case "union": {
              extensions.polymorphism = {
                mode: "union",
              };
              break;
            }
            default: {
              throw new Error(`Unsupported (or not provided) @interface mode`);
            }
          }
        }
      },
    },
  },
  schema: {
    hooks: {
      init(_, build, _context) {
        const {
          inflection,
          options: { pgForbidSetofFunctionsToReturnNull, simpleCollections },
          setGraphQLTypeForPgCodec,
        } = build;
        for (const codec of build.pgCodecMetaLookup.keys()) {
          build.recoverable(null, () => {
            if (!codec.columns) {
              // Only apply to codecs that define columns
              return;
            }
            const polymorphism = codec.extensions?.polymorphism;
            if (!polymorphism) {
              // Don't build polymorphic types as objects
              return;
            }

            const behavior = getBehavior(codec.extensions);
            const defaultBehavior = [
              "select",
              "table",
              ...(!codec.isAnonymous ? ["insert", "update"] : []),
              ...(simpleCollections === "both"
                ? ["connection", "list"]
                : simpleCollections === "only"
                ? ["list"]
                : ["connection"]),
            ].join(" ");

            const isTable = build.behavior.matches(
              behavior,
              "table",
              defaultBehavior,
            );
            if (!isTable || codec.isAnonymous) {
              return;
            }

            const selectable = build.behavior.matches(
              behavior,
              "select",
              defaultBehavior,
            );

            if (selectable) {
              if (polymorphism.mode === "single") {
                const interfaceTypeName = inflection.tableType(codec);
                build.registerInterfaceType(
                  interfaceTypeName,
                  {
                    pgCodec: codec,
                    isPgPolymorphicTableType: true,
                    pgPolymorphism: polymorphism,
                  },
                  () => ({
                    description: codec.extensions?.description,
                  }),
                  `PgPolymorphismPlugin table type for ${codec.name}`,
                );
                setGraphQLTypeForPgCodec(codec, ["output"], interfaceTypeName);
                build.registerCursorConnection({
                  typeName: interfaceTypeName,
                  connectionTypeName: inflection.tableConnectionType(codec),
                  edgeTypeName: inflection.tableEdgeType(codec),
                  scope: {
                    isPgConnectionRelated: true,
                    pgCodec: codec,
                  },
                  nonNullNode: pgForbidSetofFunctionsToReturnNull,
                });
                for (const [typeIdentifier, spec] of Object.entries(
                  polymorphism.types,
                )) {
                  const tableTypeName = spec.name;
                  build.registerObjectType(
                    tableTypeName,
                    {
                      pgCodec: codec,
                      isPgTableType: true,
                      pgPolymorphism: polymorphism,
                      pgPolymorphicSingleTableType: {
                        typeIdentifier,
                        name: spec.name,
                        columns: spec.columns,
                      },
                    },
                    // TODO: we actually allow a number of different plans; should we make this an array? See: PgClassSingleStep
                    ExecutableStep, // PgClassSingleStep<any, any, any, any>
                    () => ({
                      description: codec.extensions?.description,
                      interfaces: [
                        build.getTypeByName(
                          interfaceTypeName,
                        ) as GraphQLInterfaceType,
                      ],
                    }),
                    `PgPolymorphismPlugin table type for ${codec.name}`,
                  );
                  build.registerCursorConnection({
                    typeName: tableTypeName,
                    connectionTypeName:
                      inflection.connectionType(tableTypeName),
                    edgeTypeName: inflection.edgeType(tableTypeName),
                    scope: {
                      isPgConnectionRelated: true,
                      pgCodec: codec,
                    },
                    nonNullNode: pgForbidSetofFunctionsToReturnNull,
                  });
                }
              }
            }
          });
        }
        return _;
      },
      GraphQLSchema_types(types, build, context) {
        for (const type of types) {
          if (isInterfaceType(type)) {
            const scope = build.scopeByType.get(type) as
              | GraphileBuild.ScopeInterface
              | undefined;
            if (scope) {
              const polymorphism = scope.pgPolymorphism;
              if (polymorphism) {
                switch (polymorphism.mode) {
                  case "single": {
                    for (const type of Object.values(polymorphism.types)) {
                      // Force the type to be built
                      const t = build.getTypeByName(
                        type.name,
                      ) as GraphQLNamedType;
                      types.push(t);
                    }
                  }
                }
              }
            }
          }
        }
        return types;
      },
    },
  },
};
