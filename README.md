# Example Alchemy Notify Webhooks Server in Node

A simple example webhook server for using Alchemy Notify that uses node express.

## Installation

#### Simple setup

First, install Yarn if you don't have it:

```
npm install -g yarn
```

Then, install the dependencies of all packages:

```
yarn(or npm install)
```

## Run

To run on localhost:8080:

```
yarn start(or npm start)
```

Please change ALCHEMY_API_KEY

(If you are using webhook) Please change WEBHOOK_SIGNING_KEY to the signing key corresponding to your webhook, which you can find [here](https://docs.alchemy.com/alchemy/enhanced-apis/notify-api/using-notify#1.-find-your-signing-key)

And just like that, you're done!

NOTE: Your webhook path is currently set to "/webhook" in `src/index.ts`, but feel free to change it to whatever path you'd like.

Sample Webhook GraphQL query:

{
    block {
      logs(filter: {addresses: [], topics: []}) {
        transaction {
          hash
          index
          from {
            address
          }
          to {
            address
          }
          logs {
            account {
              address
            }
            topics
            data
          }
          type
          status
        }
      }
    }
  }

## Debugging

If you aren't receiving any webhooks, be sure you followed the steps [here first](https://github.com/alchemyplatform/#readme).
