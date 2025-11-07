How to run:

1. Clone this Repo
2. Install Ollama to your machine
3. Install Ollama Mistral to your machine
4. a. ollama pull mistral
5. run the Ollama Mistral by **ollama run mistral**
6. install all dependencies by **npm install**
7. run this project in your local machine 
**node server.js**
8. now the API is ready to use
curl -X POST http://localhost:3000/parse \
  -H "Content-Type: application/json" \
  -d '{"text": "Give me 2 chees burgers and one crystal"}'
