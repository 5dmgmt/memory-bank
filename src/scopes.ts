/**
 * スコープマネージャー
 * Global / Agent / User レベルでメモリを分離
 */

export interface ScopeDefinition {
  description?: string;
}

export interface ScopeConfig {
  defaultScope: string;
  definitions: Record<string, ScopeDefinition>;
}

export interface ScopeManager {
  resolve(agentId?: string, userScope?: string): string;
  isValid(scope: string): boolean;
  listScopes(): string[];
  defaultScope: string;
}

const BUILT_IN_SCOPES: Record<string, ScopeDefinition> = {
  global: { description: "全エージェント共有スコープ" },
  _system: { description: "システム内部用" },
};

/**
 * ScopeManager を生成
 */
export function createScopeManager(config?: Partial<ScopeConfig>): ScopeManager {
  const defaultScope = config?.defaultScope || "global";
  const definitions: Record<string, ScopeDefinition> = {
    ...BUILT_IN_SCOPES,
    ...(config?.definitions || {}),
  };

  return {
    defaultScope,

    resolve(agentId?: string, userScope?: string): string {
      // 明示的スコープが指定されていればそれを使う
      if (userScope && this.isValid(userScope)) return userScope;
      // エージェントIDがあればエージェント固有スコープ
      if (agentId) return `agent:${agentId}`;
      return defaultScope;
    },

    isValid(scope: string): boolean {
      // 定義済みスコープまたは agent: プレフィックス
      return scope in definitions || scope.startsWith("agent:");
    },

    listScopes(): string[] {
      return Object.keys(definitions);
    },
  };
}
