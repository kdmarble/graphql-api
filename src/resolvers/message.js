import { combineResolvers } from "graphql-resolvers";
import { isAuthenticated, isMessageOwner } from "./authorization";
import Sequelize from "sequelize";
// import pubsub, { EVENTS } from "../subscription";
import { PubSub } from "apollo-server";
import { withFilter } from "apollo-server";

const pubsub = new PubSub();
const MESSAGE_CREATED = "MESSAGE_CREATED";
const USER_TYPING = "USER_TYPING";

const toCursorHash = string => Buffer.from(string).toString("base64");

const fromCursorHash = string =>
  Buffer.from(string, "base64").toString("ascii");

export default {
  Query: {
    messages: async (parent, { cursor, limit = 100 }, { db }) => {
      const cursorOptions = cursor
        ? {
            where: {
              createdAt: {
                [Sequelize.Op.lt]: fromCursorHash(cursor)
              }
            }
          }
        : {};

      // Retrieve one more message than defined in the limit
      const messages = await db.message.findAll({
        order: [["createdAt", "ASC"]],
        limit: limit + 1,
        ...cursorOptions
      });

      // If the list of messages is longer than the limit, there's a next page
      const hasNextPage = messages.length > limit;
      const edges = hasNextPage ? messages.slice(0, -1) : messages;

      return {
        edges,
        pageInfo: {
          hasNextPage,
          endCursor: toCursorHash(edges[edges.length - 1].createdAt.toString())
        }
      };
    },
    message: async (parent, { id }, { db }) => {
      return await db.message.findByPk(id);
    }
  },

  Mutation: {
    createMessage: combineResolvers(
      isAuthenticated,
      async (parent, { text, senderMail, receiverMail }, { db, me }) => {
        try {
          const message = await db.message.create({
            text,
            senderMail,
            receiverMail,
            userId: me.id
          });

          pubsub.publish(MESSAGE_CREATED, {
            messageCreated: message
          });

          return message;
        } catch (error) {
          console.log(error);
          throw new Error("Error creating message");
        }
      }
    ),

    deleteMessage: combineResolvers(
      isAuthenticated,
      isMessageOwner,
      async (parent, { id }, { db }) => {
        try {
          return await db.message.destroy({ where: { id } });
        } catch (error) {
          throw new Error("Error deleting message");
        }
      }
    ),

    updateMessage: combineResolvers(
      isAuthenticated,
      isMessageOwner,
      async (parent, { id, text }, { db }) => {
        try {
          return await db.message.update(
            { text: text },
            {
              where: {
                userId: id
              }
            }
          );
        } catch (error) {
          throw new Error("Error updating message");
        }
      }
    ),
    userTyping: async (parent, { senderMail, receiverMail }, { db }) => {
      pubsub.publish(USER_TYPING, {
        userTyping: {
          senderMail,
          receiverMail
        }
      });
      return true;
    }
  },

  Message: {
    user: async (message, args, { loaders }) => {
      return await loaders.user.load(message.userId);
    }
  },

  Subscription: {
    messageCreated: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(MESSAGE_CREATED),
        (payload, variables) => {
          return payload.messageCreated.receiverMail === variables.receiverMail;
        }
      )
    },
    userTyping: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(USER_TYPING),
        (payload, variables) => {
          return payload.userTyping.receiverMail === variables.receiverMail;
        }
      )
    }
  }
};
