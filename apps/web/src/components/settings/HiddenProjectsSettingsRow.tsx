import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useEnvironmentIdentities } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function HiddenProjectsSettingsRow() {
  const hiddenProjects = useClientSettings((s) => s.sidebarHiddenProjects);
  const projects = useProjects();
  const environments = useEnvironmentIdentities();

  const projectByKey = new Map<string, (typeof projects)[number]>(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const environmentLabelById = new Map<string, string>(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const unhide = (key: string) =>
    void updateClientSettings({
      sidebarHiddenProjects: hiddenProjects.filter((candidate) => candidate !== key),
    });

  return (
    <SettingsRow
      {...searchableSetting("hidden-projects")}
      description={
        hiddenProjects.length === 0
          ? "None. Right-click a thread and choose Hide to keep its project out of this device's sidebar and notifications."
          : "Projects whose threads stay out of the sidebar and notifications on this device. Other devices are unaffected."
      }
    >
      {hiddenProjects.length === 0 ? null : (
        <ul className="divide-y divide-border/60 pt-2 pb-2">
          {hiddenProjects.map((key) => {
            const project = projectByKey.get(key);
            const environmentId = project?.environmentId ?? key.slice(0, key.indexOf(":"));
            const environmentLabel = environmentLabelById.get(environmentId) ?? "Disconnected";
            return (
              <li key={key} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">
                    {project?.title ?? "Unavailable project"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{environmentLabel}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => unhide(key)}>
                  Unhide
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsRow>
  );
}
