import { openapiToFunctions } from "@/lib/openapi-conversion"
import { checkApiKey, getServerProfile } from "@/lib/server/server-chat-helpers"
import { Tables } from "@/supabase/types"
import { ChatSettings } from "@/types"
import { OpenAIStream, StreamingTextResponse } from "ai"
import OpenAI from "openai"
import { ChatCompletionCreateParamsBase } from "openai/resources/chat/completions.mjs"

export async function POST(request: Request) {
  const json = await request.json()
  const { chatSettings, messages, selectedTools } = json as {
    chatSettings: ChatSettings
    messages: any[]
    selectedTools: Tables<"tools">[]
  }

  try {
    console.log("Fetching server profile...")
    const profile = await getServerProfile()
    console.log("Server profile fetched:", profile)

    // Log the environment variable directly
    console.log("Environment OPENAI_API_KEY:", process.env.OPENAI_API_KEY)

    checkApiKey(profile.openai_api_key, "OpenAI")

    const openai = new OpenAI({
      apiKey: profile.openai_api_key || "",
      organization: profile.openai_organization_id
    })

    // Log the API key to debug
    console.log("Using OpenAI API Key:", profile.openai_api_key)

    let allTools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
    let allRouteMaps = {}
    let schemaDetails = []

    for (const selectedTool of selectedTools) {
      try {
        console.log("Converting schema for tool:", selectedTool.name)
        const convertedSchema = await openapiToFunctions(
          JSON.parse(selectedTool.schema as string)
        )
        console.log(
          "Schema converted successfully for tool:",
          selectedTool.name
        )

        const tools = convertedSchema.functions || []
        allTools = allTools.concat(tools)

        const routeMap = convertedSchema.routes.reduce(
          (map: Record<string, string>, route) => {
            map[route.path.replace(/{(\w+)}/g, ":$1")] = route.operationId
            return map
          },
          {}
        )

        allRouteMaps = { ...allRouteMaps, ...routeMap }

        schemaDetails.push({
          title: convertedSchema.info.title,
          description: convertedSchema.info.description,
          url: convertedSchema.info.server,
          headers: selectedTool.custom_headers,
          routeMap,
          requestInBody: convertedSchema.routes[0].requestInBody
        })
      } catch (error: any) {
        console.error(
          "Error converting schema for tool:",
          selectedTool.name,
          error
        )
      }
    }

    console.log("Sending request to OpenAI for chat completion...")
    const firstResponse = await openai.chat.completions.create({
      model: chatSettings.model as ChatCompletionCreateParamsBase["model"],
      messages,
      tools: allTools.length > 0 ? allTools : undefined
    })
    console.log("Received response from OpenAI:", firstResponse)

    const message = firstResponse.choices[0].message
    messages.push(message)
    const toolCalls = message.tool_calls || []

    if (toolCalls.length === 0) {
      return new Response(message.content, {
        headers: {
          "Content-Type": "application/json"
        }
      })
    }

    if (toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const functionCall = toolCall.function
        const functionName = functionCall.name
        const argumentsString = toolCall.function.arguments.trim()
        const parsedArgs = JSON.parse(argumentsString)

        console.log("Processing tool call:", functionName)

        const schemaDetail = schemaDetails.find(detail =>
          Object.values(detail.routeMap).includes(functionName)
        )

        if (!schemaDetail) {
          throw new Error(`Function ${functionName} not found in any schema`)
        }

        const pathTemplate = Object.keys(schemaDetail.routeMap).find(
          key => schemaDetail.routeMap[key] === functionName
        )

        if (!pathTemplate) {
          throw new Error(`Path for function ${functionName} not found`)
        }

        const path = pathTemplate.replace(/:(\w+)/g, (_, paramName) => {
          const value = parsedArgs.parameters[paramName]
          if (!value) {
            throw new Error(
              `Parameter ${paramName} not found for function ${functionName}`
            )
          }
          return encodeURIComponent(value)
        })

        if (!path) {
          throw new Error(`Path for function ${functionName} not found`)
        }

        const isRequestInBody = schemaDetail.requestInBody
        let data = {}

        if (isRequestInBody) {
          let headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${profile.openai_api_key}`
          }

          const customHeaders = schemaDetail.headers
          if (customHeaders && typeof customHeaders === "string") {
            let parsedCustomHeaders = JSON.parse(customHeaders) as Record<
              string,
              string
            >
            headers = {
              ...headers,
              ...parsedCustomHeaders
            }
          }

          let fullUrl = schemaDetail.url + path

          // Force correct DALLE endpoint
          if (fullUrl.includes("/v1/images/generations")) {
            fullUrl = "https://api.openai.com/v1/images/generations"
          }

          const bodyContent = parsedArgs.requestBody || parsedArgs

          // Log the API key and request details before making the request
          console.log("Using API Key for request:", profile.openai_api_key)
          console.log(
            "Sending POST request to:",
            fullUrl,
            "with body:",
            bodyContent
          )

          const requestInit = {
            method: "POST",
            headers,
            body: JSON.stringify(bodyContent)
          }

          const response = await fetch(fullUrl, requestInit)

          if (!response.ok) {
            const errorData = await response.json()
            console.error(
              "Error from DALLE API:",
              response.statusText,
              errorData
            )
            data = {
              error: response.statusText,
              details: errorData
            }
          } else {
            data = await response.json()
            console.log("Received response from DALLE image generation:", data)
          }
        } else {
          const queryParams = new URLSearchParams(
            parsedArgs.parameters
          ).toString()
          const fullUrl =
            schemaDetail.url + path + (queryParams ? "?" + queryParams : "")

          let headers = {
            Authorization: `Bearer ${profile.openai_api_key}`
          }

          const customHeaders = schemaDetail.headers
          if (customHeaders && typeof customHeaders === "string") {
            headers = JSON.parse(customHeaders)
          }

          console.log("Sending GET request to:", fullUrl)

          const response = await fetch(fullUrl, {
            method: "GET",
            headers: headers
          })

          if (!response.ok) {
            const errorData = await response.json()
            console.error(
              "Error from DALLE API:",
              response.statusText,
              errorData
            )
            data = {
              error: response.statusText,
              details: errorData
            }
          } else {
            data = await response.json()
            console.log("Received response from DALLE image generation:", data)
          }
        }

        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: JSON.stringify(data)
        })
      }
    }

    console.log("Sending second request to OpenAI for chat completion...")
    const secondResponse = await openai.chat.completions.create({
      model: chatSettings.model as ChatCompletionCreateParamsBase["model"],
      messages,
      stream: true
    })
    console.log("Received streaming response from OpenAI")

    const stream = OpenAIStream(secondResponse)

    return new StreamingTextResponse(stream)
  } catch (error: any) {
    console.error("Error in POST handler:", error)
    const errorMessage = error.error?.message || "An unexpected error occurred"
    const errorCode = error.status || 500
    return new Response(JSON.stringify({ message: errorMessage }), {
      status: errorCode,
      headers: { "Content-Type": "application/json" }
    })
  }
}
