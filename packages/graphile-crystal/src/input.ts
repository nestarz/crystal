import * as assert from "assert";
import { inspect } from "util";
import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLType,
  isLeafType,
  GraphQLInputObjectType,
} from "graphql";
import { Aether } from "./aether";
import {
  GraphQLInputType,
  ArgumentNode,
  NamedTypeNode,
  ListTypeNode,
  NonNullTypeNode,
} from "graphql";
import { __TrackedObjectPlan, Plan } from "./plan";

export type InputPlan =
  | __TrackedObjectPlan // .get(), .eval(), .evalIs(), .evalHas(), .at(), .evalLength()
  | InputListPlan // .at(), .eval(), .evalLength()
  | InputStaticLeafPlan // .eval(), .evalIs()
  | InputObjectPlan; // .get(), .eval(), .evalHas()

function graphqlGetTypeForNode(
  aether: Aether,
  node: NamedTypeNode | ListTypeNode | NonNullTypeNode,
): GraphQLType {
  switch (node.kind) {
    case "NamedType": {
      const type = aether.schema.getType(node.name.value);
      if (!type) {
        // Should not happen since the GraphQL operation has already been
        // validated against the schema.
        throw new Error(
          `Could not find type with name '${node.name.value}' in the schema`,
        );
      }
      return type;
    }
    case "ListType":
      return new GraphQLList(graphqlGetTypeForNode(aether, node.type));
    case "NonNullType":
      return new GraphQLNonNull(graphqlGetTypeForNode(aether, node.type));
    default: {
      const never: never = node;
      throw new Error(`Unknown node kind; node: ${inspect(never)}`);
    }
  }
}

export function inputPlan(
  aether: Aether,
  inputType: GraphQLInputType,
  rawInputValue: ArgumentNode | undefined,
  defaultValue: any = undefined,
): InputPlan {
  let inputValue = rawInputValue;
  if (inputValue?.value.kind === "Variable") {
    const variableName = inputValue.value.name.value;
    const variableDefinition = aether.operation.variableDefinitions?.find(
      (def) => def.variable.name.value === variableName,
    );
    if (!variableDefinition) {
      // Should not happen since the GraphQL operation has already been
      // validated.
      throw new Error(`No definition for variable '${variableName}' found`);
    }
    const variableType = graphqlGetTypeForNode(aether, variableDefinition.type);
    return inputVariablePlan(
      aether,
      variableName,
      variableType,
      inputType,
      defaultValue,
    );
  }
  // Note: past here we know whether `defaultValue` will be used or not because
  // we know `inputValue` is not a variable.
  inputValue = inputValue ?? defaultValue;
  if (inputType instanceof GraphQLNonNull) {
    const innerType = inputType.ofType;
    const valuePlan = inputPlan(aether, innerType, inputValue);
    return inputNonNullPlan(aether, valuePlan);
  } else if (inputType instanceof GraphQLList) {
    const innerType: GraphQLInputType = inputType.ofType;
    return inputListPlan(aether, innerType, inputValue);
  } else if (isLeafType(inputType)) {
    return inputStaticLeafPlan(aether, inputType, inputValue);
  } else if (inputType instanceof GraphQLInputObjectType) {
    return inputObjectPlan(aether, inputType, inputValue);
  } else {
    const never: never = inputType;
    throw new Error(`Unsupported type in inputPlan: '${inspect(never)}'`);
  }
}

function doTypesMatch(a: GraphQLInputType, b: GraphQLInputType): boolean {
  if (a instanceof GraphQLNonNull && b instanceof GraphQLNonNull) {
    return doTypesMatch(a.ofType, b.ofType);
  } else if (a instanceof GraphQLList && b instanceof GraphQLList) {
    return doTypesMatch(a.ofType, b.ofType);
  } else {
    return a === b;
  }
}

function inputVariablePlan(
  aether: Aether,
  variableName: string,
  variableType: GraphQLInputType,
  inputType: GraphQLInputType,
  defaultValue: any = undefined,
): InputPlan {
  if (
    variableType instanceof GraphQLNonNull &&
    !(inputType instanceof GraphQLNonNull)
  ) {
    const unwrappedVariableType = variableType.ofType;
    return inputVariablePlan(
      aether,
      variableName,
      unwrappedVariableType,
      inputType,
      defaultValue,
    );
  }
  const typesMatch = doTypesMatch(variableType, inputType);
  assert.ok(typesMatch, "Expected variable and input types to match");
  const variableValuePlan = aether.trackedVariableValuesPlan.get(variableName);
  if (defaultValue === undefined || !variableValuePlan.evalIs(undefined)) {
    // There's no default value, or we know for sure that our variable will be
    // set (even if null) and thus the default will not be used; use the variable.
    return variableValuePlan;
  } else {
    // `defaultValue` is NOT undefined, and we know variableValue is
    // `undefined` (and always will be); we're going to loop back and pretend
    // that no value was passed in the first place (instead of the variable):
    return inputPlan(aether, inputType, undefined, defaultValue);
  }
}

/**
 * Implements `InputNonNullPlan`.
 */
function inputNonNullPlan(aether: Aether, innerPlan: InputPlan): InputPlan {
  return innerPlan;
}

/**
 * Implements `InputListPlan`.
 */
class InputListPlan extends Plan {
  private itemPlans: InputPlan[] = [];
  private outOfBoundsPlan: InputPlan;

  constructor(
    aether: Aether,
    inputType: GraphQLList<GraphQLInputType>,
    private readonly inputValues: ArgumentNode | undefined,
  ) {
    super(aether);
    assert.ok(
      inputType instanceof GraphQLList,
      "Expected inputType to be a List",
    );
    const innerType = inputType.ofType;
    if (inputValues && inputValues.value.kind === "ListValue") {
      const values = inputValues.value.values;
      for (
        let inputValueIndex = 0, inputValuesLength = values.length;
        inputValueIndex < inputValuesLength;
        inputValueIndex++
      ) {
        const inputValue = inputValues[inputValueIndex];
        const innerPlan = inputPlan(aether, innerType, inputValue);
        this.itemPlans.push(innerPlan);
      }
    }
    // TODO: is `outOfBoundsPlan` safe? Maybe it was before we simplified
    // `InputNonNullPlan`, but maybe it's not safe any more?
    this.outOfBoundsPlan = inputPlan(aether, innerType, undefined);
  }

  execute(values: any[][]): any[] {
    const { inputValues } = this;

    /**
     * All the results will be the same, so generate them once and then share
     * them with everyone.
     */
    let eachResult;
    if (inputValues?.value.kind === "NullValue") {
      eachResult = null;
    } else {
      const itemPlansLength = this.itemPlans.length;
      const list = new Array(itemPlansLength);
      for (
        let itemPlanIndex = 0;
        itemPlanIndex < itemPlansLength;
        itemPlanIndex++
      ) {
        const itemPlan = this.itemPlans[itemPlanIndex];
        const value = itemPlan.eval();
        list[itemPlanIndex] = value;
      }
      eachResult = list;
    }

    return new Array(values.length).fill(eachResult);
  }

  at(index: number): InputPlan {
    return this.itemPlans[index] || this.outOfBoundsPlan;
  }

  eval(): any[] | null {
    if (this.inputValues?.value.kind === "NullValue") {
      return null;
    }
    const itemPlansLength = this.itemPlans.length;
    const list = new Array(itemPlansLength);
    for (
      let itemPlanIndex = 0;
      itemPlanIndex < itemPlansLength;
      itemPlanIndex++
    ) {
      const itemPlan = this.itemPlans[itemPlanIndex];
      const value = itemPlan.eval();
      list[itemPlanIndex] = value;
    }
    return list;
  }
}
