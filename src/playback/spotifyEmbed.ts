// Spotify's official Embed iFrame API: lets the page start a track in the embedded Spotify player
// and listen for playback progress, so the car mode can move on when a song ends.
// https://developer.spotify.com/documentation/embeds/references/iframe-api
// The audio stays inside Spotify's player – the app only says "play this" and listens.

export interface PlaybackUpdate {
  isPaused: boolean;
  isBuffering: boolean;
  /** milliseconds */
  duration: number;
  /** milliseconds */
  position: number;
}

export interface EmbedController {
  loadUri(uri: string): void;
  play(): void;
  pause(): void;
  resume(): void;
  togglePlay(): void;
  seek(seconds: number): void;
  destroy(): void;
  addListener(event: 'ready', cb: () => void): void;
  addListener(event: 'playback_update', cb: (e: { data: PlaybackUpdate }) => void): void;
}

interface IFrameAPI {
  createController(
    element: HTMLElement,
    options: { uri: string; width?: string | number; height?: string | number },
    callback: (controller: EmbedController) => void,
  ): void;
}

declare global {
  interface Window {
    onSpotifyIframeApiReady?: (api: IFrameAPI) => void;
  }
}

let apiPromise: Promise<IFrameAPI> | null = null;

export function loadIFrameApi(timeoutMs = 10000): Promise<IFrameAPI> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<IFrameAPI>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      apiPromise = null;
      reject(new Error('Spotify-Player konnte nicht geladen werden (keine Verbindung?).'));
    }, timeoutMs);
    window.onSpotifyIframeApiReady = (api) => {
      window.clearTimeout(timer);
      resolve(api);
    };
    const s = document.createElement('script');
    s.src = 'https://open.spotify.com/embed/iframe-api/v1';
    s.async = true;
    s.onerror = () => {
      window.clearTimeout(timer);
      apiPromise = null;
      reject(new Error('Spotify-Player konnte nicht geladen werden (keine Verbindung?).'));
    };
    document.body.appendChild(s);
  });
  return apiPromise;
}

/** Create a controller inside `host` (the API replaces a child element with its iframe). */
export async function createEmbed(host: HTMLElement, trackId: string): Promise<EmbedController> {
  const api = await loadIFrameApi();
  host.innerHTML = '';
  const el = document.createElement('div');
  host.appendChild(el);
  return new Promise((resolve) => {
    api.createController(el, { uri: `spotify:track:${trackId}`, width: '100%', height: 152 }, (c) => resolve(c));
  });
}
