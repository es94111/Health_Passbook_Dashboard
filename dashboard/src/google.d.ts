// Minimal type declarations for Google Identity Services (GSI)
// https://developers.google.com/identity/gsi/web/reference/js-reference

interface GoogleCredentialResponse {
  credential: string;
  select_by: string;
}

interface GoogleAccountsId {
  initialize(config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: 'standard' | 'icon';
      theme?: 'outline' | 'filled_blue' | 'filled_black';
      size?: 'large' | 'medium' | 'small';
      text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
      shape?: 'rectangular' | 'pill' | 'circle' | 'square';
      width?: number | string;
      locale?: string;
    },
  ): void;
  prompt(): void;
  disableAutoSelect(): void;
  revoke(hint: string, callback: () => void): void;
}

interface Window {
  google?: {
    accounts: {
      id: GoogleAccountsId;
    };
  };
}
