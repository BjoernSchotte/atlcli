declare module "virtual:atlcli-publication" {
  export const bundlePath: string;
  export const labelRoutePrefix: string | undefined;
  export const publicationSite: string | undefined;
  export const publicationSiteName: string | undefined;
  export const publicationSeo: import("@atlcli/web-publish").PublicationSeoOptionsV1 | undefined;
  export const publicationI18n: import("@atlcli/web-publish").PublicationI18nOptionsV1 | undefined;
}
