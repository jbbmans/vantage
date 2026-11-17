import { useLayoutEffect } from 'react';

/**
 * The document title a page gives itself, over the one its frame works out from the address. A page that is not what
 * its address says (no page here, a kind of record this page cannot show, a console section) names itself, and the
 * frame's title, set after the page has drawn, keeps that name instead of putting its own back.
 */
let own: string | null = null;

/** The title to set: the page's own while it has one, otherwise the frame's. */
export const pageTitle = (fallback: string) => own ?? fallback;

/** Names the document while this page is shown. A layout effect, so it is in place before the frame's title effect reads it. */
export function usePageTitle(title: string | null | undefined) {
  useLayoutEffect(() => {
    if (!title) return;
    own = title;
    document.title = title;
    return () => { if (own === title) own = null; };
  }, [title]);
}
