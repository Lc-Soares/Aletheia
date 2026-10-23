// Tipos mínimos do Google Identity Services, só o que o front usa.
interface PromptMomentNotification {
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
  isDismissedMoment(): boolean;
}

interface Window {
  google?: typeof google;
  onGoogleLibraryLoad?: () => void;
}

declare const google: {
  accounts: {
    id: {
      initialize(config: {
        client_id: string;
        callback: (response: { credential: string }) => void;
        auto_select?: boolean;
      }): void;
      renderButton(parent: HTMLElement, options: Record<string, string>): void;
      prompt(listener?: (notification: PromptMomentNotification) => void): void;
    };
  };
};
