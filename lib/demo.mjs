const JOBS = [
  ["顧客ポータルの実装", "Atlas", "engineering", "working"],
  ["ログイン画面の不具合を修正", "Atlas", "engineering", "working"],
  ["リリース前のテスト", "Atlas", "engineering", "waiting"],
  ["ブランドのビジュアル制作", "Bloom", "design", "working"],
  ["新しいロゴのデザイン", "Bloom", "design", "done"],
  ["新サービスのプレスリリース", "Bloom", "pr", "working"],
  ["SNSの投稿プラン", "Bloom", "pr", "waiting"],
  ["導入提案書をまとめる", "Orbit", "sales", "working"],
  ["お客様向けの見積作成", "Orbit", "sales", "idle"],
  ["来週のブログ記事を執筆", "Journal", "writing", "working"],
  ["ニュースレターの校正", "Journal", "writing", "done"],
  ["市場の動向を調査", "Orbit", "research", "working"],
  ["ユーザーインタビューを分析", "Atlas", "research", "waiting"],
  ["次の四半期のロードマップ", "Atlas", "planning", "working"],
  ["チームの会議予定を整理", "Orbit", "operations", "done"],
];
export function demoSnapshot() {
  const now = new Date().toISOString();
  return {
    tasks: JOBS.map(([title, project, roleHint, status], i) => ({
      id: `demo-${i}`,
      title,
      project,
      roleHint,
      status,
      activeRoles:
        status === "working"
          ? (i === 0
              ? ["engineering", "design"]
              : i === 5
                ? ["pr", "writing"]
                : i === 7
                  ? ["sales", "design"]
                  : [roleHint]
            ).map((roleId) => ({ roleId, evidence: "Demo activity" }))
          : [],
      source: i % 3 === 0 ? "work" : "codex",
      updatedAt: now,
      observedAt: now,
      summary: "サンプルの仕事です。実際のタスクは操作しません。",
    })),
    health: { status: "demo", message: "サンプルデータ" },
  };
}
