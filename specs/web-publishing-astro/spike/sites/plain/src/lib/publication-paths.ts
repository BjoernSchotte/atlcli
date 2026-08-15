import { getCollection } from "astro:content";
import { publicationRoutePath, type T0PublicationPage } from "@atlcli/web-publish-astro-spike";

export async function getPublicationPaths(locale: string) {
  const pages = await getCollection("publicationPages");
  return pages
    .filter((entry) => entry.data.locale === locale)
    .map((entry) => {
      const route = publicationRoutePath(entry.data);
      const prefix = locale === "en" ? "/publish" : `/${locale}/publish`;
      const suffix = route.slice(prefix.length).replace(/^\//u, "");
      return {
        params: { slug: suffix || undefined },
        props: { entry },
      };
    });
}

export function publicationCanonicalPath(page: T0PublicationPage): string {
  return `/docs${publicationRoutePath(page)}/`;
}
