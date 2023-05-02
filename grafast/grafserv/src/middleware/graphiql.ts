import type { RuruHTMLParts, RuruServerConfig } from "ruru/server";
import { defaultHTMLParts, makeHTMLParts, ruruHTML } from "ruru/server";

import { getGrafservHooks } from "../hooks.js";
import type { HandlerResult, NormalizedRequestDigest } from "../interfaces.js";
import type { OptionsFromConfig } from "../options.js";

// TODO: use a specific version of mermaid
export function makeGraphiQLHandler(
  resolvedPreset: GraphileConfig.ResolvedPreset,
  dynamicOptions: OptionsFromConfig,
) {
  const { htmlParts: htmlPartsFromConfig } = resolvedPreset?.ruru ?? {};
  const hooks = getGrafservHooks(resolvedPreset);
  const unhookedHTMLParts: RuruHTMLParts = {
    ...defaultHTMLParts,
    ...htmlPartsFromConfig,
  };
  return async (request: NormalizedRequestDigest): Promise<HandlerResult> => {
    let htmlParts = unhookedHTMLParts!;
    if (hooks.callbacks.ruruHTMLParts) {
      const hookData = {
        request,
        parts: {
          ...makeHTMLParts(),
          ...htmlPartsFromConfig,
        },
      };
      await hooks.process("ruruHTMLParts", hookData);
      htmlParts = hookData.parts;
    }
    const config: RuruServerConfig = {
      endpoint: dynamicOptions.graphqlPath,
      // TODO: websocket endpoint
      debugTools:
        dynamicOptions.explain === true
          ? ["explain", "plan"]
          : dynamicOptions.explain === false
          ? []
          : (dynamicOptions.explain as any[]),
    };
    return {
      statusCode: 200,
      request,
      dynamicOptions,
      type: "html",
      payload: Buffer.from(ruruHTML(config, htmlParts), "utf8"),
    };
  };
}
