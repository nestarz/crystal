declare global {
  namespace GraphileConfig {
    interface Plugin {
      name: string;
      version: string;
      experimental?: boolean;
      description?: string;
      provides?: string[];
      after?: string[];
      before?: string[];
    }

    /**
     * A Graphile Config Preset that can be combined with other presets to
     * ultimately build a resolved preset: a combination of plugins and
     * configuration options to be used by the various Graphile tools.
     */
    interface Preset {
      extends?: ReadonlyArray<Preset>;
      plugins?: Plugin[];
      disablePlugins?: ReadonlyArray<string>;
      // **IMPORTANT**: if a key gets added here, make sure it's also added to the
      // isScopeKeyForPreset check.
    }

    interface ResolvedPreset extends Preset {
      // As Preset, except extends is an empty array and plugins is definitely set.
      extends?: ReadonlyArray<never>;
      plugins?: Plugin[];
      disablePlugins?: ReadonlyArray<string>;
    }
  }
}

export type PluginHookObject<T extends (...args: any[]) => any> = {
  provides?: string[];
  before?: string[];
  after?: string[];
  callback: T;
};

export type PluginHook<T extends (...args: any[]) => any> =
  | T
  | PluginHookObject<T>;

export type PluginHookCallback<T extends PluginHook<(...args: any[]) => any>> =
  T extends PluginHook<infer U> ? U : never;
