import type { Plugin } from "graphile-plugin";

import { version } from "../index";

declare module "@dataplan/pg" {
  interface PgTypeCodecTags {
    deprecated: string | string[];
  }
}

export const PgColumnDeprecationPlugin: Plugin = {
  name: "PgColumnDeprecationPlugin",
  description: "Marks a column as deprecated if it has the deprecated tag",
  version: version,
  schema: {
    hooks: {
      GraphQLObjectType_fields_field(field, build, context) {
        const {
          scope: { pgCodec, fieldName },
          Self,
        } = context;
        const deprecated = pgCodec?.extensions?.tags?.deprecated;
        if (!deprecated) {
          return field;
        }
        return build.extend(
          field,
          {
            deprecationReason: Array.isArray(deprecated)
              ? deprecated.join("\n")
              : String(deprecated),
          },
          `Deprecating ${Self.name}.${fieldName}`,
        );
      },
    },
  },
};
