import {
  GraphQLSchema,
  GraphQLString,
  GraphQLFloat,
  GraphQLList,
  GraphQLObjectType,
  printSchema,
  isInputType,
  GraphQLScalarType,
  GraphQLObjectTypeConfig,
  GraphQLInt,
  GraphQLFieldConfigMap,
} from 'graphql';

import { ResolverGenerator } from './resolvers';
import { Config, Field, KsqlDBResponse, KSqlDBEntities } from './type/definition';

const TypeMap = {
  STRING: GraphQLString,
  VARCHAR: GraphQLString,
  BIGINT: GraphQLFloat, // the BIGINT that is given back is larger than graphql supports, so it has to be a float
  DOUBLE: GraphQLFloat,
  INTEGER: GraphQLFloat,
  ARRAY: {
    STRING: new GraphQLList(GraphQLString),
    VARCHAR: new GraphQLList(GraphQLString),
    BIGINT: new GraphQLList(GraphQLFloat),
    INTEGER: new GraphQLList(GraphQLFloat),
    DOUBLE: new GraphQLList(GraphQLFloat),
  },
  STRUCT: {}, // MemberSchema exclude not excluding this?
};

const setSchemaType = (accum: KSqlDBEntities, field: Field): void => {
  if (TypeMap[field.schema.type] == null) {
    // eslint-disable-next-line
    console.error(`type ${field.schema.type} is not supported`);
    return;
  }

  if (field.schema.memberSchema?.type != null) {
    const sclarType: GraphQLScalarType = TypeMap[field.schema.type][
      field.schema.memberSchema.type
    ] as GraphQLScalarType;
    accum[field.name] = {
      type: sclarType,
    };
  } else {
    const sclarType: GraphQLScalarType = TypeMap[field.schema.type] as GraphQLScalarType;
    accum[field.name] = {
      type: sclarType,
    };
  }
};

const buildSchemaObject = (accum: KSqlDBEntities, field: Field): KSqlDBEntities => {
  if (field.schema.fields == null) {
    setSchemaType(accum, field);
  } else if (Array.isArray(field.schema.fields)) {
    const fields = field.schema.fields.reduce(buildSchemaObject, {});
    if (accum[field.name] == null) {
      accum[field.name] = { type: new GraphQLObjectType({ name: field.name, fields: fields }) };
    } else {
      // eslint-disable-next-line
      console.warn(`${field.name} already exists.`);
    }
  }
  return accum;
};

export const generateSchemaFromKsql = ({
  name,
  fields,
}: KsqlDBResponse): GraphQLObjectTypeConfig<void, void> => {
  const schemaFields = fields.reduce(buildSchemaObject, {});
  return {
    name,
    fields: {
      ...schemaFields,
      // for debugging
      command: {
        type: GraphQLString,
      },
    },
  };
};

// TODO support nested objects for resolving
const generateGraqphQLArgs = (fields: any): any =>
  Object.keys(fields).reduce((accum: any, filter: any) => {
    if (isInputType(fields[filter].type)) {
      accum[filter] = fields[filter];
    }
    return accum;
  }, {});

export const generateSchemaAndFields = (
  streams: Array<KsqlDBResponse>
): { schema: GraphQLSchema; fields: GraphQLFieldConfigMap<any, any, any> } => {
  const schemas: GraphQLObjectTypeConfig<void, void>[] = [];
  for (const stream of streams) {
    schemas.push(generateSchemaFromKsql(stream));
  }

  const queryFields = schemas.reduce((accum: { [name: string]: any }, query: any) => {
    const schemaType = new GraphQLObjectType(query);
    const args = generateGraqphQLArgs(query.fields);
    accum[query.name] = {
      type: schemaType,
      args,
    };
    return accum;
  }, {});
  const mutationFields = schemas.reduce((accum: { [name: string]: any }, query: any) => {
    const args = generateGraqphQLArgs(query.fields);
    accum[query.name] = {
      type: new GraphQLObjectType({
        name: 'KsqlMutation',
        fields: {
          command: {
            type: GraphQLString,
          },
          status: {
            type: GraphQLInt,
          },
        },
      }),
      args,
    };
    return accum;
  }, {});
  const queryType = new GraphQLObjectType({ name: 'Query', fields: queryFields });
  const subscriptionType = new GraphQLObjectType({ name: 'Subscription', fields: queryFields });
  const mutationType = new GraphQLObjectType({ name: 'Mutation', fields: mutationFields });
  const gqlSchema = new GraphQLSchema({
    query: queryType,
    subscription: subscriptionType,
    mutation: mutationType,
  });

  return { schema: gqlSchema, fields: queryFields };
};

const schemas = async (
  requester: any
): Promise<{ schema: GraphQLSchema; fields: GraphQLFieldConfigMap<any, any, any> } | undefined> => {
  try {
    const response = await requester.post(
      'ksql',
      {
        ksql: 'show tables extended;',
      },
      { timeout: 1000 }
    );

    if (response.status !== 200) {
      // eslint-disable-next-line
      console.error(`request to ksql failed`, response);
      return;
    }

    const streams: Array<KsqlDBResponse> = response.data[0].sourceDescriptions;

    if (streams.length === 0) {
      throw new Error(`No ksql tables exist on ksql server ${requester.defaults.baseURL}`);
    }
    return generateSchemaAndFields(streams);
  } catch (e) {
    // eslint-disable-next-line
    console.error(`Could not generate schemas:`, e.message);
  }
};

export function buildKsqlDBGraphQL({
  requester,
}: Config): Promise<{
  schemas: any;
  queryResolvers: any;
  subscriptionResolvers: any;
  mutationResolvers: any;
}> {
  return new Promise(resolve => {
    (async function run(): Promise<void> {
      try {
        const result = await schemas(requester);
        if (result) {
          // eslint-disable-next-line
          console.log(printSchema(result.schema));
          const {
            queryResolvers,
            subscriptionResolvers,
            mutationResolvers,
          } = new ResolverGenerator(result.fields);
          resolve({
            schemas: result.schema,
            queryResolvers,
            subscriptionResolvers,
            mutationResolvers,
          });
        } else {
          throw new Error('Unable to create schemas and resolvers');
        }
      } catch {
        // noop
      }
    })();
  });
}
