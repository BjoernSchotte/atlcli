import React from "react";
import type { ScreenProps } from "../../utils/screens/registry.js";
import { useT } from "../../utils/i18n/context.js";
import { Card, CardContent } from "../ui/card.js";
import { SectionHeading } from "../ui/field.js";

/**
 * About screen. Renders the injected {@link HostInfo} — the replacement for
 * `App.tsx`'s module-scope `chrome.runtime.getManifest()` — which makes it the
 * cheapest possible proof that the host description really is data.
 */
export function AboutScreen({ ports }: ScreenProps): React.JSX.Element {
  const t = useT();
  const { host } = ports;
  return (
    <div className="flex flex-col gap-3" data-testid="about-screen">
      <SectionHeading>{t("about.title")}</SectionHeading>
      <Card>
        <CardContent className="flex flex-col gap-1 p-3 text-xs">
          <div className="text-sm font-semibold">{host.name}</div>
          <div className="text-muted-foreground" data-testid="about-version">
            {t("app.version", { version: host.version })}
          </div>
          <dl className="m-0 mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-muted-foreground">
            <dt className="font-semibold">{t("about.host")}</dt>
            <dd className="m-0" data-testid="about-host-kind">
              {host.kind}
            </dd>
            <dt className="font-semibold">{t("about.capabilities")}</dt>
            <dd className="m-0 break-words" data-testid="about-capabilities">
              {host.capabilities.length > 0 ? host.capabilities.join(", ") : "—"}
            </dd>
          </dl>
          <p className="m-0 mt-1 text-muted-foreground">{t("about.licence")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
