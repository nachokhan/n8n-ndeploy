export class TransformService {
  patchWorkflowIds(rawWorkflow: unknown, idMap: Record<string, string>): unknown {
    return this.walk(rawWorkflow, [], idMap);
  }

  private walk(value: unknown, path: Array<string>, idMap: Record<string, string>): unknown {
    if (Array.isArray(value)) {
      return value.map((item, index) => this.walk(item, [...path, String(index)], idMap));
    }

    if (value !== null && typeof value === "object") {
      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};

      for (const [key, child] of Object.entries(source)) {
        const nextPath = [...path, key];

        if (
          key === "id" &&
          nextPath.length >= 3 &&
          nextPath[nextPath.length - 3] === "credentials" &&
          nextPath[nextPath.length - 1] === "id" &&
          typeof child === "string" &&
          idMap[child]
        ) {
          result[key] = idMap[child];
          continue;
        }

        if (
          (key === "workflowId" || key === "tableId" || key === "dataTableId") &&
          this.patchReferenceField(result, key, child, idMap)
        ) {
          continue;
        }

        if (
          key === "errorWorkflow" &&
          path[path.length - 1] === "settings" &&
          this.patchReferenceField(result, key, child, idMap)
        ) {
          continue;
        }

        result[key] = this.walk(child, nextPath, idMap);
      }

      return result;
    }

    return value;
  }

  private patchReferenceField(
    target: Record<string, unknown>,
    key: string,
    value: unknown,
    idMap: Record<string, string>,
  ): boolean {
    if (typeof value === "string" || typeof value === "number") {
      const mapped = idMap[String(value)];
      if (mapped) {
        target[key] = mapped;
        return true;
      }
      return false;
    }

    if (!value || typeof value !== "object") {
      return false;
    }

    const refObject = value as Record<string, unknown>;
    const refValue = refObject.value;
    if (typeof refValue === "string" || typeof refValue === "number") {
      const mapped = idMap[String(refValue)];
      if (mapped) {
        target[key] = {
          ...refObject,
          value: mapped,
        };
        return true;
      }
    }

    const refId = refObject.id;
    if (typeof refId === "string" || typeof refId === "number") {
      const mapped = idMap[String(refId)];
      if (mapped) {
        target[key] = {
          ...refObject,
          id: mapped,
        };
        return true;
      }
    }

    return false;
  }
}
