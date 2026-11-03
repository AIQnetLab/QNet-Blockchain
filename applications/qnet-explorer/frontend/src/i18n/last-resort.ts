// The error pages' words that must be at hand without a catalog, in every language: the page shown when the root layout
// fails has no layout to hand it its texts, and loading its language's catalog would leave it in another language, or
// empty, while that file loads. The page under the layout takes its Reload label from here too, so it is written once.

import type { Locale } from '../lib/languages.ts';

export interface LastResortTexts {
  readonly title: string;
  readonly lead: string;
  readonly reload: string;
}

export const LAST_RESORT: Readonly<Record<Locale, LastResortTexts>> = {
  en: {
    title: 'aiqnet.io could not load',
    lead: 'Something in the browser stopped the page, often another extension. Reload the page to try again.',
    reload: 'Reload',
  },
  'zh-CN': {
    title: 'aiqnet.io 无法加载',
    lead: '浏览器中的某些内容阻止了页面，通常是其他扩展。请重新加载页面后重试。',
    reload: '重新加载',
  },
  ru: {
    title: 'Не удалось загрузить aiqnet.io',
    lead: 'Что-то в браузере остановило страницу, часто это другое расширение. Перезагрузите страницу, чтобы попробовать снова.',
    reload: 'Перезагрузить',
  },
  es: {
    title: 'aiqnet.io no pudo cargarse',
    lead: 'Algo en el navegador detuvo la página, a menudo otra extensión. Recarga la página para intentarlo de nuevo.',
    reload: 'Recargar',
  },
  ko: {
    title: 'aiqnet.io를 불러올 수 없습니다',
    lead: '브라우저의 무언가가 페이지를 멈췄습니다. 다른 확장 프로그램인 경우가 많습니다. 다시 시도하려면 페이지를 새로고침하세요.',
    reload: '새로고침',
  },
  ja: {
    title: 'aiqnet.io を読み込めませんでした',
    lead: 'ブラウザー内の何か（多くの場合は他の拡張機能）がページを止めました。もう一度試すには、ページを再読み込みしてください。',
    reload: '再読み込み',
  },
  pt: {
    title: 'Não foi possível carregar a aiqnet.io',
    lead: 'Algo no navegador interrompeu a página, muitas vezes outra extensão. Recarregue a página para tentar de novo.',
    reload: 'Recarregar',
  },
  fr: {
    title: 'aiqnet.io n’a pas pu se charger',
    lead: 'Quelque chose dans le navigateur a arrêté la page, souvent une autre extension. Rechargez la page pour réessayer.',
    reload: 'Recharger',
  },
  de: {
    title: 'aiqnet.io ließ sich nicht laden',
    lead: 'Etwas im Browser hat die Seite gestoppt, oft eine andere Erweiterung. Laden Sie die Seite neu, um es erneut zu versuchen.',
    reload: 'Neu laden',
  },
  ar: {
    title: 'تعذّر تحميل aiqnet.io',
    lead: 'أوقف شيء ما في المتصفح الصفحة، وغالبًا ما تكون إضافة أخرى. أعد تحميل الصفحة للمحاولة مرة أخرى.',
    reload: 'إعادة التحميل',
  },
  it: {
    title: 'Impossibile caricare aiqnet.io',
    lead: 'Qualcosa nel browser ha bloccato la pagina, spesso un\'altra estensione. Ricarica la pagina per riprovare.',
    reload: 'Ricarica',
  },
};
