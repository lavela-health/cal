import { COMPANY_NAME } from "@calcom/lib/constants";
import classNames from "@calcom/ui/classNames";

export function Logo({
  small,
  icon,
  inline = true,
  className,
  src = "/api/logo",
}: {
  small?: boolean;
  icon?: boolean;
  inline?: boolean;
  className?: string;
  src?: string;
}) {
  const sizing = icon ? "mx-auto w-9" : small ? "h-4 w-auto" : "h-5 w-auto";
  const lightType = icon ? "icon" : "logo";

  return (
    <h3 className={classNames("logo", inline && "inline", className)}>
      <strong>
        {/* Two assets rather than one with `dark:invert`: inverting the wordmark turns its
            warm ink cold. The API resolves both to the same team logo when one is set. */}
        <img
          className={classNames(sizing, "dark:hidden")}
          alt={COMPANY_NAME}
          title={COMPANY_NAME}
          src={`${src}?type=${lightType}`}
        />
        <img
          className={classNames(sizing, "hidden dark:inline")}
          alt={COMPANY_NAME}
          title={COMPANY_NAME}
          src={`${src}?type=${lightType}-dark`}
        />
      </strong>
    </h3>
  );
}
