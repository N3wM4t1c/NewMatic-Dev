import $RefParser from "@apidevtools/json-schema-ref-parser"

// Interface for OpenAPI data structure
interface OpenAPIData {
  info: {
    title: string
    description: string
    server: string
  }
  routes: {
    path: string
    method: string
    operationId: string
    requestInBody?: boolean
  }[]
  functions: any
}

// Service configuration map based on server URLs
const serviceConfigMap: Record<
  string,
  { name: string; apiKey: string; baseUrl: string }
> = {
  "https://api.openai.com": {
    name: "openai",
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: "https://api.openai.com/v1"
  },
  "https://api.anthropic.com": {
    name: "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    baseUrl: "https://api.anthropic.com/v1"
  },
  "https://gemini.googleapis.com": {
    name: "google_gemini",
    apiKey: process.env.GOOGLE_GEMINI_API_KEY || "",
    baseUrl: "https://gemini.googleapis.com/v1"
  },
  "https://api.mistral.com": {
    name: "mistral",
    apiKey: process.env.MISTRAL_API_KEY || "",
    baseUrl: "https://api.mistral.com/v1"
  },
  "https://api.groq.com": {
    name: "groq",
    apiKey: process.env.GROQ_API_KEY || "",
    baseUrl: "https://api.groq.com/v1"
  },
  "https://api.perplexity.ai": {
    name: "perplexity",
    apiKey: process.env.PERPLEXITY_API_KEY || "",
    baseUrl: "https://api.perplexity.ai/v1"
  },
  "https://api.openrouter.ai": {
    name: "openrouter",
    apiKey: process.env.OPENROUTER_API_KEY || "",
    baseUrl: "https://api.openrouter.ai/v1"
  },
  "https://serpapi.com": {
    name: "serpapi",
    apiKey: process.env.SERPAPI_API_KEY || "",
    baseUrl: "https://serpapi.com/v1"
  },
  "https://api.huggingface.co": {
    name: "huggingface",
    apiKey: process.env.HUGGING_FACE_API_KEY || "",
    baseUrl: "https://api.huggingface.co"
  }
}

// Function to select the appropriate service configuration based on the OpenAPI schema server URL
const getServiceConfig = (serverUrl: string) => {
  if (serverUrl.includes("openai.com")) {
    if (serverUrl.includes("/images/generations")) {
      // Add a specific check for the DALL-E service
      return {
        name: "DALL-E",
        apiKey: process.env.OPENAI_API_KEY,
        serviceUrl: "https://api.openai.com/v1/images/generations"
      }
    }
    // Handle other OpenAI services like ChatGPT, embeddings, etc.
    return {
      name: "OpenAI",
      apiKey: process.env.OPENAI_API_KEY,
      serviceUrl: "https://api.openai.com/v1"
    }
  }
  // Add support for other services like Replicate, Anthropic, etc.
  const service = serviceConfigMap[serverUrl]
  if (!service) {
    throw new Error(`Unsupported service for server URL: ${serverUrl}`)
  }
  return service
}

// Validate the OpenAPI spec and ensure it is correct
export const validateOpenAPI = async (openapiSpec: any) => {
  if (!openapiSpec.info) {
    throw new Error("('info'): field required")
  }
  if (!openapiSpec.info.title) {
    throw new Error("('info', 'title'): field required")
  }
  if (!openapiSpec.info.version) {
    throw new Error("('info', 'version'): field required")
  }
  if (
    !openapiSpec.servers ||
    !openapiSpec.servers.length ||
    !openapiSpec.servers[0].url
  ) {
    throw new Error("Could not find a valid URL in `servers`")
  }
  if (!openapiSpec.paths || Object.keys(openapiSpec.paths).length === 0) {
    throw new Error("No paths found in the OpenAPI spec")
  }
  Object.keys(openapiSpec.paths).forEach(path => {
    if (!path.startsWith("/")) {
      throw new Error(`Path ${path} does not start with a slash; skipping`)
    }
  })
}

// Function to convert OpenAPI to internal routes and functions
export const openapiToFunctions = async (
  openapiSpec: any
): Promise<OpenAPIData> => {
  const functions: any[] = []
  const routes: {
    path: string
    method: string
    operationId: string
    requestInBody?: boolean
  }[] = []

  const serverUrl = openapiSpec.servers[0].url

  // Get the service configuration based on the server URL
  const serviceConfig = getServiceConfig(serverUrl)

  // Log the service configuration to debug
  console.log("Service Configuration:", serviceConfig)

  // Iterate through paths and methods
  for (const [path, methods] of Object.entries(openapiSpec.paths)) {
    if (typeof methods !== "object" || methods === null) {
      continue
    }
    for (const [method, specWithRef] of Object.entries(
      methods as Record<string, any>
    )) {
      const spec: any = await $RefParser.dereference(specWithRef)
      const functionName = spec.operationId
      const desc = spec.description || spec.summary || ""

      const schema: { type: string; properties: any; required?: string[] } = {
        type: "object",
        properties: {}
      }

      const reqBody = spec.requestBody?.content?.["application/json"]?.schema
      if (reqBody) {
        schema.properties.requestBody = reqBody
      }

      const params = spec.parameters || []
      if (params.length > 0) {
        const paramProperties = params.reduce((acc: any, param: any) => {
          if (param.schema) {
            acc[param.name] = param.schema
          }
          return acc
        }, {})
        schema.properties.parameters = {
          type: "object",
          properties: paramProperties
        }
      }

      functions.push({
        type: "function",
        function: {
          name: functionName,
          description: desc,
          parameters: schema
        }
      })

      const requestInBody = !!spec.requestBody

      routes.push({
        path,
        method,
        operationId: functionName,
        requestInBody
      })
    }
  }

  return {
    info: {
      title: openapiSpec.info.title,
      description: openapiSpec.info.description,
      server: serviceConfig.serviceUrl // Use the correct base URL from serviceConfig
    },
    routes,
    functions
  }
}

// Use environment variables from .env.local and dynamically select API keys based on service
export const getApiKey = (service: string) => {
  const serviceConfig = serviceConfigMap[service]
  if (!serviceConfig || !serviceConfig.apiKey) {
    throw new Error(`API key not found for service: ${service}`)
  }
  return serviceConfig.apiKey
}
