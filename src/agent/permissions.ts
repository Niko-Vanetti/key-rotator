/**
 * Claude-Code-style permission gate for the agent's risky actions.
 * Reads/listings are free; write / delete / command / folder-change ask the
 * user via a modal prompt with Allow / Allow-all-this-chat / Deny.
 * "Allow all" is per CATEGORY and per CONVERSATION (reset() on new chat).
 */

export type PermCategory = 'read' | 'write' | 'delete' | 'command' | 'folder';

export type PermAnswer = 'allow' | 'allowAll' | 'deny';

/** UI adapter: shows `message` and returns the user's pick (undefined = dismissed). */
export type PermPrompt = (message: string, category: PermCategory) => Promise<PermAnswer | undefined>;

export const CATEGORY_LABELS: Record<PermCategory, string> = {
  read: 'leer FUERA de la carpeta de trabajo',
  write: 'escribir archivos',
  delete: 'borrar archivos',
  command: 'ejecutar comandos',
  folder: 'cambiar la carpeta de trabajo',
};

export class PermissionGate {
  private allowed = new Set<PermCategory>();

  constructor(private prompt: PermPrompt) {}

  /** Forget every "allow all" — called when a new conversation starts. */
  reset(): void {
    this.allowed.clear();
  }

  /**
   * Ask (or auto-allow if the category was granted for this chat).
   * `detail` is the exact path/command shown to the user.
   */
  async ask(category: PermCategory, detail: string): Promise<boolean> {
    if (this.allowed.has(category)) return true;
    const answer = await this.prompt(
      `El agente quiere ${CATEGORY_LABELS[category]}:\n\n${detail}`,
      category
    );
    if (answer === 'allowAll') {
      this.allowed.add(category);
      return true;
    }
    return answer === 'allow';
  }
}
