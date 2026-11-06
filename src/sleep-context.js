const TOPICS = [
  { names: '包管理器', predicate: 'package-manager', tag: '包管理器', values: 'pnpm|npm|yarn|bun' },
  { names: '数据库', predicate: 'storage', tag: '数据库', values: 'SQLite|PostgreSQL|MySQL|MongoDB|Redis' },
  { names: '命令行|终端|shell', predicate: 'shell', tag: '命令行', values: 'PowerShell|bash|zsh|cmd' },
  { names: '编辑器', predicate: 'editor', tag: '编辑器', values: 'Neovim|nvim|Vim|Emacs|VSCode' },
];

export const SLEEP_CONTEXT_VERSION = 'local-question-answer-v1';

export function contextualSleepCandidate(text, previous) {
  if (!previous || typeof previous.text !== 'string' || typeof text !== 'string') return null;
  const question = previous.text.trim(), answer = text.trim();
  for (const topic of TOPICS) {
    const project = `(?:这个项目|本项目|当前项目|本仓库)`;
    const person = topic.predicate === 'editor' ? '(?:我的|我写代码的)' : '(?!)';
    const questionPattern = new RegExp(
      `^(?:(${project})(?:目前|现在|默认)?(?:的)?|(${person}))(?:(${topic.names})(?:是什么|用什么|用哪个|选什么|选择什么|使用什么)|(?:使用|采用|用)(?:哪(?:个|种)|什么)(${topic.names}))[?？]$`, 'i',
    );
    const match = questionPattern.exec(question);
    if (!match) continue;
    const answerMatch = new RegExp(`^(?:(?:我|我们)?(?:选择|决定使用|使用|采用|用|选)\\s*)?(${topic.values})[。.!！]?$`, 'i').exec(answer);
    if (!answerMatch) return null;
    const subject = match[1] ? 'workspace.project' : 'user';
    const value = answerMatch[1];
    return {
      text: answer, layer: 'L2', category: 'knowledge', horizon: 'unspecified',
      kind: 'inference', status: 'candidate', rule: 'bounded-question-answer',
      claim: { subject, predicate: topic.predicate, value, polarity: 'positive', scope: 'space' },
      factKey: `${subject}.${topic.predicate}`, tags: [topic.tag],
      contextSourceId: previous.id,
    };
  }
  return null;
}
