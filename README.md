How to run:

1. Clone this Repo
2. Install Ollama to your machine
3. Install Ollama Mistral to your machine
4. install all dependencies by **npm install**
5. run this project in your local machine 
**node server.js**
6. now the API is ready to use
curl -X POST http://localhost:3000/parse \
  -H "Content-Type: application/json" \
  -d '{"text": "Give me 2 chees burgers and one crystal"}'
